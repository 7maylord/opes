import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CircleWalletService } from '../src/circle-wallet.service';
import { DatabaseService } from '../src/database.service';
import { PaymentExecutionWorkerService } from '../src/payment-execution-worker.service';
import { SessionService } from '../src/session.service';
import { workspaceKinds, WorkspaceService } from '../src/workspace.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('Workspace read models (e2e)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const membershipId = randomUUID();
  const agentId = randomUUID();
  const vendorId = randomUUID();
  const vendorAddressId = randomUUID();
  const documentId = randomUUID();
  const obligationId = randomUUID();
  const invoiceVersionId = randomUUID();
  const revokedDecisionId = randomUUID();
  const expiredDecisionId = randomUUID();
  const governingSourceId = randomUUID();
  const governingVersionId = randomUUID();
  const deliverySourceId = randomUUID();
  const deliveryVersionId = randomUUID();
  const stagedObligationId = randomUUID();
  const stagedInvoiceId = randomUUID();
  const orderDocumentId = randomUUID();
  const receiptDocumentId = randomUUID();
  const connectorId = randomUUID();
  let paymentExecutionId!: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CircleWalletService)
      .useValue({ isConfigured: () => false })
      .compile();
    app = module.createNestApplication();
    await app.init();
    database = app.get(DatabaseService);
    await database.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users (id, email, display_name) VALUES ($1, $2, 'Workspace Tester')`,
        [userId, `workspace-${userId}@example.com`],
      ),
    );
    await seedOrganization(organizationId, true);
    await seedOrganization(otherOrganizationId, false);
    await seedApprovalFixtures();
    sessionToken = await app.get(SessionService).createSession(userId);
  });

  it('queries every record type through tenant RLS', async () => {
    const workspace = app.get(WorkspaceService);
    const context = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      membershipId: '33333333-3333-3333-3333-333333333333',
      role: 'OWNER' as const,
      agentId: '44444444-4444-4444-8444-444444444444',
      requestId: 'workspace-e2e',
    };

    for (const kind of workspaceKinds) {
      await expect(
        workspace.list(context, kind, { limit: '1' }),
      ).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
    }
  });

  it('runs as a non-bypass role and hides tenant rows without scope', async () => {
    const role = await database.withDatabase((sql) =>
      sql.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      ),
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const unscoped = await database.withDatabase((sql) =>
      sql.query('SELECT id FROM opes.organizations WHERE id = $1', [
        organizationId,
      ]),
    );
    expect(unscoped.rows).toEqual([]);
  });

  it('serves only the authenticated tenant and rejects expired sessions', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const response = await request(server)
      .get(`/organizations/${organizationId}/workspace/vendor`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200);
    const body = response.body as unknown as {
      items: Array<{ id: string; title: string }>;
    };
    expect(body.items[0]).toMatchObject({
      id: vendorId,
      title: 'Fixture Vendor',
    });

    await request(server)
      .get(`/organizations/${otherOrganizationId}/workspace/vendor`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(404);

    await request(server)
      .get(`/organizations/${organizationId}/workspace/vendor`)
      .set('Authorization', 'Bearer expired-session')
      .expect(401);
  });

  it('rejects revoked and expired approvals through the execution API', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    await request(server)
      .post(
        `/organizations/${organizationId}/decisions/${revokedDecisionId}/execute`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(404);
    await request(server)
      .post(
        `/organizations/${organizationId}/decisions/${expiredDecisionId}/execute`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(409)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ message: 'Payment approval is expired' }),
      );
  });

  it('accepts and accrues a staged invoice only after a complete match', async () => {
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.evidence_documents
          (id,organization_id,document_type,filename,content_type,size_bytes,
           sha256_hex,storage_key,status,created_by_membership_id)
         VALUES
          ($1,$3,'OTHER','po.txt','text/plain',1,$4,$5,'VERIFIED',$6),
          ($2,$3,'RECEIPT','receipt.txt','text/plain',1,$7,$8,'VERIFIED',$6)`,
        [
          orderDocumentId,
          receiptDocumentId,
          organizationId,
          '1'.repeat(64),
          `fixture/${orderDocumentId}`,
          membershipId,
          '2'.repeat(64),
          `fixture/${receiptDocumentId}`,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligations
          (id,organization_id,vendor_id,source_reference,obligation_key,status,created_by_membership_id)
         VALUES ($1,$2,$3,'INV-MATCH',$4,'PENDING_MATCH',$5)`,
        [
          stagedObligationId,
          organizationId,
          vendorId,
          '3'.repeat(64),
          membershipId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligation_versions
          (id,organization_id,obligation_id,version,evidence_document_id,vendor_id,
           vendor_address_id,invoice_number,currency,amount_atomic,amount_decimals,
           line_items,content_hash,status,created_by_membership_id)
         VALUES ($1,$2,$3,1,$4,$5,$6,'INV-MATCH','USDC',1000000,6,$7::jsonb,$8,
           'PENDING_MATCH',$9)`,
        [
          stagedInvoiceId,
          organizationId,
          stagedObligationId,
          documentId,
          vendorId,
          vendorAddressId,
          JSON.stringify([
            {
              description: 'Catering',
              quantityMicros: '1000000',
              amountAtomic: '1000000',
            },
          ]),
          '4'.repeat(64),
          membershipId,
        ],
      );
    });

    const server = app.getHttpAdapter().getInstance() as App;
    const headers = { Authorization: `Bearer ${sessionToken}` };
    const order = await request(server)
      .post(`/organizations/${organizationId}/procurement-evidence`)
      .set(headers)
      .send({
        evidenceType: 'PURCHASE_ORDER',
        vendorId,
        sourceReference: 'PO-MATCH',
        currency: 'USDC',
        totalAmount: '1',
        evidenceDocumentId: orderDocumentId,
        lineItems: [{ description: 'Catering', quantity: '1', amount: '1' }],
      })
      .expect(201);
    const orderBody = order.body as unknown as { sourceId: string };
    const receipt = await request(server)
      .post(`/organizations/${organizationId}/procurement-evidence`)
      .set(headers)
      .send({
        evidenceType: 'PURCHASE_RECEIPT',
        vendorId,
        sourceReference: 'PR-MATCH',
        currency: 'USDC',
        totalAmount: '1',
        governingSourceId: orderBody.sourceId,
        evidenceDocumentId: receiptDocumentId,
        lineItems: [{ description: 'Catering', quantity: '1', amount: '1' }],
      })
      .expect(201);
    const receiptBody = receipt.body as unknown as { sourceId: string };
    await request(server)
      .post(
        `/organizations/${organizationId}/invoices/${stagedInvoiceId}/match`,
      )
      .set(headers)
      .send({
        governingSourceId: orderBody.sourceId,
        deliverySourceId: receiptBody.sourceId,
      })
      .expect(201)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ status: 'PASS', reasons: [] }),
      );

    const proof = await database.withOrganizationScope(organizationId, (sql) =>
      sql.query<{
        version_status: string;
        obligation_status: string;
        lines: string;
      }>(
        `SELECT version.status AS version_status,
             obligation.status AS obligation_status,
             COUNT(ledger.id)::text AS lines
           FROM opes.payable_obligation_versions version
           JOIN opes.payable_obligations obligation
             ON obligation.organization_id=version.organization_id
            AND obligation.id=version.obligation_id
           LEFT JOIN opes.ledger_entries ledger
             ON ledger.organization_id=version.organization_id
            AND ledger.ledger_event_type='INVOICE_ACCEPTED'
            AND ledger.ledger_event_id=version.id
           WHERE version.organization_id=$1 AND version.id=$2
           GROUP BY version.status,obligation.status`,
        [organizationId, stagedInvoiceId],
      ),
    );
    expect(proof.rows[0]).toEqual({
      version_status: 'ACCEPTED',
      obligation_status: 'ACCEPTED',
      lines: '2',
    });
  });

  it('calculates treasury truth and prevents concurrent over-reservation', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const authorization = `Bearer ${sessionToken}`;
    await database.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `UPDATE opes.treasury_reservations SET status='RELEASED'
         WHERE organization_id=$1 AND decision_id=$2`,
        [organizationId, expiredDecisionId],
      ),
    );
    await request(server)
      .put(`/organizations/${organizationId}/treasury/settings`)
      .set('Authorization', authorization)
      .send({
        operatingBufferAtomic: '100000',
        monthlyBudgetAtomic: '10000000',
        maxSnapshotAgeSeconds: 300,
      })
      .expect(200);
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.treasury_balance_snapshots
          (organization_id,environment,address,asset_symbol,block_number,balance_atomic)
         VALUES ($1,'arc-testnet',$2,'USDC',100,1500000)`,
        [organizationId, '0x3000000000000000000000000000000000000003'],
      );
      await sql.query(
        `INSERT INTO opes.treasury_balance_reads
          (organization_id,environment,status,block_number)
         VALUES ($1,'arc-testnet','SUCCESS',100)`,
        [organizationId],
      );
    });
    await request(server)
      .get(`/organizations/${organizationId}/treasury/position`)
      .set('Authorization', authorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({
          snapshotStatus: 'FRESH',
          authorizationReady: true,
          verifiedBalanceAtomic: '1500000',
          operatingBufferAtomic: '100000',
          availableLiquidityAtomic: '1400000',
          forecast30DaysAtomic: '2000000',
          forecast90DaysAtomic: '2000000',
        }),
      );

    const decisionBody = (invoiceId: string) => ({
      invoiceVersionId: invoiceId,
      modelAction: 'PAY',
      modelName: 'fixture',
      modelRationale: 'verified payable',
      promptVersion: 'f5-e2e',
      route: {
        liquidityRoute: 'OPERATING',
        environment: 'arc-testnet',
        chainId: 5042002,
        assetSymbol: 'USDC',
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const decisions = await Promise.all([
      request(server)
        .post(`/organizations/${organizationId}/decisions/invoice-payment`)
        .set('Authorization', authorization)
        .send(decisionBody(invoiceVersionId))
        .expect(201),
      request(server)
        .post(`/organizations/${organizationId}/decisions/invoice-payment`)
        .set('Authorization', authorization)
        .send(decisionBody(stagedInvoiceId))
        .expect(201),
    ]);
    const actions = decisions
      .map(
        (response) =>
          (response.body as unknown as { derivedAction: string }).derivedAction,
      )
      .sort();
    expect(actions).toEqual(['PAY', 'REJECT']);
    const reservations = await database.withOrganizationScope(
      organizationId,
      (sql) =>
        sql.query<{ count: string; amount: string }>(
          `SELECT count(*)::text AS count,COALESCE(sum(amount_atomic),0)::text AS amount
           FROM opes.treasury_reservations
           WHERE organization_id=$1 AND status='ACTIVE' AND expires_at>now()`,
          [organizationId],
        ),
    );
    expect(reservations.rows[0]).toEqual({ count: '1', amount: '1000000' });

    const payableDecision = decisions.find(
      (response) =>
        (response.body as { derivedAction: string }).derivedAction === 'PAY',
    );
    expect(payableDecision).toBeDefined();
    await database.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `INSERT INTO opes.tenant_resource_bindings
          (organization_id,environment,chain_id,provider,resource_type,resource_id,address,status)
         VALUES ($1,'arc-testnet',5042002,'circle','operator_wallet',$2,$3,'ACTIVE')`,
        [
          organizationId,
          `wallet-${organizationId}`,
          '0x5000000000000000000000000000000000000005',
        ],
      ),
    );
    const execution = await request(server)
      .post(
        `/organizations/${organizationId}/decisions/${(payableDecision?.body as { id: string }).id}/execute`,
      )
      .set('Authorization', authorization)
      .expect(201);
    paymentExecutionId = (execution.body as { id: string }).id;
    const originalFetch = global.fetch;
    const originalRpc = process.env.OPES_RPC_ARC_TESTNET;
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.test.invalid';
    global.fetch = jest
      .fn()
      .mockImplementation(
        (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (typeof init?.body !== 'string')
            throw new Error('RPC body missing');
          const body = init.body;
          const method = (JSON.parse(body) as { method: string }).method;
          const result =
            method === 'eth_blockNumber'
              ? '0x64'
              : method === 'eth_getTransactionCount'
                ? '0x1'
                : method === 'eth_call' && body.includes('5c975abb')
                  ? '0x0'
                  : '0x989680';
          return { ok: true, json: () => Promise.resolve({ result }) };
        },
      ) as typeof fetch;
    try {
      await expect(
        app.get(PaymentExecutionWorkerService).processDuePaymentExecutions(20),
      ).resolves.toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
      if (originalRpc === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
      else process.env.OPES_RPC_ARC_TESTNET = originalRpc;
    }
    const preflight = await database.withOrganizationScope(
      organizationId,
      (sql) =>
        sql.query<{ status: string }>(
          `SELECT status FROM opes.payment_execution_preflights
           WHERE organization_id=$1 AND execution_id=$2`,
          [organizationId, (execution.body as { id: string }).id],
        ),
    );
    const executionState = await database.withOrganizationScope(
      organizationId,
      (sql) =>
        sql.query<{ status: string; failure_reason: string | null }>(
          `SELECT status,failure_reason FROM opes.payment_executions
           WHERE organization_id=$1 AND id=$2`,
          [organizationId, (execution.body as { id: string }).id],
        ),
    );
    expect({
      preflight: preflight.rows[0]?.status,
      execution: executionState.rows[0],
    }).toEqual({
      preflight: 'PASS',
      execution: {
        status: 'FAILED',
        failure_reason: 'Circle wallets are not configured',
      },
    });

    await request(server)
      .put(`/organizations/${organizationId}/treasury/policy`)
      .set('Authorization', authorization)
      .send({
        autonomousLimitAtomic: '1000000000',
        singlePaymentLimitAtomic: '10000000000',
        vendorDailyLimitAtomic: '25000000000',
        organizationDailyLimitAtomic: '100000000000',
        monthlyBudgetAtomic: '5000000',
        operatingBufferAtomic: '100000',
        allowedRoutes: [
          {
            liquidityRoute: 'OPERATING',
            environment: 'arc-testnet',
            chainId: 5042002,
            assetSymbol: 'USDC',
          },
        ],
        allowedAssets: ['USDC'],
      })
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ status: 'ACTIVE' }),
      );
    const invalidated = await database.withOrganizationScope(
      organizationId,
      (sql) =>
        sql.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM opes.treasury_reservations
           WHERE organization_id=$1 AND status='ACTIVE'`,
          [organizationId],
        ),
    );
    expect(invalidated.rows[0]?.count).toBe('0');
    await expect(
      database.withOrganizationScope(organizationId, (sql) =>
        sql.query(
          `UPDATE opes.payment_policy_versions
           SET autonomous_limit_atomic=autonomous_limit_atomic+1
           WHERE organization_id=$1 AND status='ACTIVE'`,
          [organizationId],
        ),
      ),
    ).rejects.toThrow('payment policy versions are immutable');

    await database.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `INSERT INTO opes.treasury_balance_reads
          (organization_id,environment,status,failure_reason)
         VALUES ($1,'arc-testnet','FAILED','RPC unavailable')`,
        [organizationId],
      ),
    );
    await request(server)
      .get(`/organizations/${organizationId}/treasury/position`)
      .set('Authorization', authorization)
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({
          snapshotStatus: 'FAILED',
          authorizationReady: false,
          availableLiquidityAtomic: '0',
        }),
      );
  });

  it('exposes settled payable lineage, blockers, and redacted connector health', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const authorization = `Bearer ${sessionToken}`;
    const transactionHash = `0x${'d'.repeat(64)}`;
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `UPDATE opes.payment_executions
            SET status='CONFIRMED',transaction_hash=$3,failure_reason=NULL,confirmed_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [organizationId, paymentExecutionId, transactionHash],
      );
      await sql.query(
        `INSERT INTO opes.payment_reconciliation_events
          (organization_id,provider,external_event_id,execution_id,transaction_hash,payload_hash)
         VALUES ($1,'circle','workspace-settlement',$2,$3,$4)`,
        [organizationId, paymentExecutionId, transactionHash, 'e'.repeat(64)],
      );
      await sql.query(
        `INSERT INTO opes.accounting_connector_bindings
          (id,organization_id,provider,label,base_url,encrypted_credentials,status,last_error,created_by_membership_id)
         VALUES ($1,$2,'ODOO','Odoo payable sync','https://private.invalid','secret-ciphertext','FAILED','Authentication failed',$3)`,
        [connectorId, organizationId, membershipId],
      );
    });
    await request(server)
      .post(
        `/organizations/${organizationId}/ledger/payment-executions/${paymentExecutionId}/settle`,
      )
      .set('Authorization', authorization)
      .expect(201);

    const detail = await request(server)
      .get(
        `/organizations/${organizationId}/workspace/invoice/${invoiceVersionId}`,
      )
      .set('Authorization', authorization)
      .expect(200);
    const detailBody = detail.body as unknown as {
      lineage: Array<{ type: string; transactionHash: string | null }>;
      blockers: Array<{ code: string }>;
    };
    expect(detailBody.lineage.map((node) => node.type)).toEqual(
      expect.arrayContaining([
        'evidence',
        'evidence_match',
        'procurement_evidence',
        'policy_decision',
        'reservation',
        'approval',
        'execution',
        'preflight',
        'reconciliation',
        'ledger',
      ]),
    );
    expect(
      detailBody.lineage.some(
        (node) => node.transactionHash === transactionHash,
      ),
    ).toBe(true);
    expect(detailBody.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['APPROVAL:REVOKED', 'APPROVAL:EXPIRED']),
    );

    const connectors = await request(server)
      .get(`/organizations/${organizationId}/workspace/connector`)
      .set('Authorization', authorization)
      .expect(200);
    expect(connectors.body).toMatchObject({
      items: [
        {
          id: connectorId,
          status: 'FAILED',
          details: { lastError: 'Authentication failed' },
        },
      ],
    });
    expect(JSON.stringify(connectors.body)).not.toContain('secret-ciphertext');
    expect(JSON.stringify(connectors.body)).not.toContain('private.invalid');
  });

  afterAll(async () => {
    for (const id of [organizationId, otherOrganizationId]) {
      await database.withOrganizationScope(id, async (sql) => {
        await sql.query(
          'DELETE FROM opes.audit_events WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.ledger_entries WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.accounting_settlement_writebacks WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.external_accounting_records WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.accounting_connector_bindings WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payable_evidence_matches WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.procurement_evidence_versions WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.procurement_evidence_sources WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.treasury_reservations WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.treasury_settings WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.treasury_balance_reads WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.treasury_balance_snapshots WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_reconciliation_events WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_execution_preflights WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_execution_attempts WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_executions WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.outbox_events WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_decision_approvals WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_decisions WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payment_policy_versions WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payable_obligation_versions WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.payable_obligations WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.evidence_documents WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.vendor_payout_addresses WHERE organization_id = $1',
          [id],
        );
        await sql.query('DELETE FROM opes.vendors WHERE organization_id = $1', [
          id,
        ]);
        await sql.query(
          'DELETE FROM opes.tenant_resource_bindings WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.business_agents WHERE organization_id = $1',
          [id],
        );
        await sql.query(
          'DELETE FROM opes.organization_memberships WHERE organization_id = $1',
          [id],
        );
        await sql.query('DELETE FROM opes.organizations WHERE id = $1', [id]);
      });
    }
    await database.withDatabase(async (sql) => {
      await sql.query('DELETE FROM opes.user_sessions WHERE user_id = $1', [
        userId,
      ]);
      await sql.query('DELETE FROM opes.app_users WHERE id = $1', [userId]);
    });
    await app.close();
  });

  async function seedOrganization(id: string, withMembership: boolean) {
    await database.withOrganizationScope(id, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations (id, slug, display_name, lifecycle_status) VALUES ($1, $2, $3, 'ACTIVE')`,
        [
          id,
          `workspace-${id}`,
          withMembership ? 'Workspace One' : 'Workspace Two',
        ],
      );
      await sql.query(
        `INSERT INTO opes.business_agents (id, organization_id, lifecycle_status) VALUES ($1, $2, 'ACTIVE')`,
        [withMembership ? agentId : randomUUID(), id],
      );
      if (withMembership) {
        await sql.query(
          `INSERT INTO opes.organization_memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')`,
          [membershipId, id, userId],
        );
        await sql.query(
          `INSERT INTO opes.payment_policy_versions (
             organization_id,version,autonomous_limit_atomic,single_payment_limit_atomic,
             vendor_daily_limit_atomic,organization_daily_limit_atomic,
             monthly_budget_atomic,operating_buffer_atomic,allowed_routes,allowed_assets,
             created_by_membership_id
           ) VALUES ($1,1,1000000000,10000000000,25000000000,100000000000,
             NULL,0,'["OPERATING:arc-testnet:5042002:USDC"]','["USDC"]',$2)`,
          [id, membershipId],
        );
        await sql.query(
          `INSERT INTO opes.vendors (id, organization_id, display_name, status, created_by_membership_id) VALUES ($1, $2, 'Fixture Vendor', 'VERIFIED', $3)`,
          [vendorId, id, membershipId],
        );
        await sql.query(
          `INSERT INTO opes.tenant_resource_bindings
            (organization_id,environment,chain_id,provider,resource_type,resource_id,address,status)
           VALUES ($1,'arc-testnet',5042002,'arc','business_policy_vault_contract',$2,$3,'ACTIVE')`,
          [id, `vault-${id}`, '0x3000000000000000000000000000000000000003'],
        );
      }
    });
  }

  async function seedApprovalFixtures() {
    await database.withOrganizationScope(organizationId, async (sql) => {
      const payoutAddress = '0x4000000000000000000000000000000000000004';
      await sql.query(
        `INSERT INTO opes.vendor_payout_addresses
          (id, organization_id, vendor_id, environment, chain_id, asset_symbol, asset_address, payout_address, status, version, created_by_membership_id)
         VALUES ($1, $2, $3, 'arc-testnet', 5042002, 'USDC', '0x3600000000000000000000000000000000000000', $4, 'VERIFIED_ACTIVE', 1, $5)`,
        [
          vendorAddressId,
          organizationId,
          vendorId,
          payoutAddress,
          membershipId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.evidence_documents
          (id, organization_id, document_type, filename, content_type, size_bytes, sha256_hex, storage_key, created_by_membership_id)
         VALUES ($1, $2, 'INVOICE', 'fixture.txt', 'text/plain', 1, $3, $4, $5)`,
        [
          documentId,
          organizationId,
          'a'.repeat(64),
          `fixture/${documentId}`,
          membershipId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligations
          (id, organization_id, vendor_id, source_reference, obligation_key, created_by_membership_id)
         VALUES ($1, $2, $3, 'INV-P9', $4, $5)`,
        [obligationId, organizationId, vendorId, 'b'.repeat(64), membershipId],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligation_versions
          (id, organization_id, obligation_id, version, evidence_document_id, vendor_id, vendor_address_id,
           invoice_number, currency, amount_atomic, amount_decimals, line_items, content_hash, created_by_membership_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6, 'INV-P9', 'USDC', 1000000, 6, '[]', $7, $8)`,
        [
          invoiceVersionId,
          organizationId,
          obligationId,
          documentId,
          vendorId,
          vendorAddressId,
          'c'.repeat(64),
          membershipId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.procurement_evidence_sources
          (id,organization_id,evidence_type,vendor_id,source_reference,created_by_membership_id)
         VALUES
          ($1,$2,'PURCHASE_ORDER',$3,'PO-P9',$4),
          ($5,$2,'PURCHASE_RECEIPT',$3,'PR-P9',$4)`,
        [
          governingSourceId,
          organizationId,
          vendorId,
          membershipId,
          deliverySourceId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.procurement_evidence_versions
          (id,organization_id,source_id,version,currency,total_amount_atomic,line_items,
           governing_source_id,evidence_document_id,created_by_membership_id)
         VALUES
          ($1,$2,$3,1,'USDC',1000000,'[]',NULL,$4,$5),
          ($6,$2,$7,1,'USDC',1000000,'[]',$3,$4,$5)`,
        [
          governingVersionId,
          organizationId,
          governingSourceId,
          documentId,
          membershipId,
          deliveryVersionId,
          deliverySourceId,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payable_evidence_matches
          (organization_id,invoice_version_id,governing_evidence_version_id,
           delivery_evidence_version_id,status,calculation_snapshot,created_by_membership_id)
         VALUES ($1,$2,$3,$4,'PASS','{}',$5)`,
        [
          organizationId,
          invoiceVersionId,
          governingVersionId,
          deliveryVersionId,
          membershipId,
        ],
      );
      for (const [index, decisionId] of [
        revokedDecisionId,
        expiredDecisionId,
      ].entries()) {
        await sql.query(
          `INSERT INTO opes.payment_decisions
            (id, organization_id, source_type, source_id, source_version_id, decision_version, payment_mode,
             model_action, derived_action, liquidity_route, route_environment, route_chain_id, route_asset_symbol,
             amount_atomic, destination_address, vendor_id, vendor_address_id, evidence_bundle_hash,
             policy_snapshot_hash, context_hash, decision_hash, checks, model_name, model_rationale,
             prompt_version, evidence_check_version, policy_version_id,bound_vendor_version,
             bound_address_version,expires_at, created_by_membership_id)
           VALUES ($1, $2, 'INVOICE', $3, $4, $5, 'DIRECT', 'PAY', 'PAY', 'OPERATING', 'arc-testnet',
             5042002, 'USDC', 1000000, $6, $7, $8, $9, $10, $11, $12, '[]', 'fixture', 'fixture',
             '1', '1', (SELECT id FROM opes.payment_policy_versions WHERE organization_id=$2 AND status='ACTIVE'),
             1,1,now() + interval '1 hour', $13)`,
          [
            decisionId,
            organizationId,
            obligationId,
            invoiceVersionId,
            index + 1,
            payoutAddress,
            vendorId,
            vendorAddressId,
            'd'.repeat(64),
            'e'.repeat(64),
            'f'.repeat(64),
            `0x${String(index + 1).repeat(64)}`,
            membershipId,
          ],
        );
        await sql.query(
          `INSERT INTO opes.payment_decision_approvals
            (organization_id, decision_id, decision_version, source_version_id, amount_atomic,
             destination_address, context_hash, policy_snapshot_hash, status, approved_by_membership_id, expires_at)
           VALUES ($1, $2, $3, $4, 1000000, $5, $6, $7, $8, $9,
             CASE WHEN $8 = 'REVOKED' THEN now() + interval '1 hour' ELSE now() - interval '1 minute' END)`,
          [
            organizationId,
            decisionId,
            index + 1,
            invoiceVersionId,
            payoutAddress,
            'f'.repeat(64),
            'e'.repeat(64),
            index === 0 ? 'REVOKED' : 'ACTIVE',
            membershipId,
          ],
        );
      }
      await sql.query(
        `INSERT INTO opes.treasury_reservations
          (organization_id,decision_id,source_version_id,amount_atomic,expires_at)
         VALUES ($1,$2,$3,1000000,now()+interval '1 hour')`,
        [organizationId, expiredDecisionId, invoiceVersionId],
      );
    });
  }
});
