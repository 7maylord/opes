import { randomUUID } from 'node:crypto';
import { keccak256, stringToHex } from 'viem';
import { addressTopic } from '../src/infrastructure/evm/lifecycle-chain-evidence';
import { DatabaseService } from '../src/core/database/database.service';
import { PaymentCorrectionService } from '../src/modules/payments/payment-correction.service';
import { TenantContext } from '../src/core/database/tenant-context';

describe('correction idempotency and capacity under concurrency', () => {
  const ids = Object.fromEntries(
    [
      'org',
      'user',
      'member',
      'vendor',
      'address',
      'document',
      'obligation',
      'version',
      'decision',
      'execution',
    ].map((name) => [name, randomUUID()]),
  );
  const vendor = `0x${'2'.repeat(40)}`,
    vault = `0x${'3'.repeat(40)}`,
    hash = 'a'.repeat(64);
  const context: TenantContext = {
    organizationId: ids.org,
    userId: ids.user,
    membershipId: ids.member,
    agentId: randomUUID(),
    role: 'OWNER',
    requestId: randomUUID(),
  };
  let db: DatabaseService, service: PaymentCorrectionService;
  beforeAll(async () => {
    db = new DatabaseService();
    service = new PaymentCorrectionService(db);
    await db.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name) VALUES($1,$2,'Correction test')`,
        [ids.user, `${ids.user}@example.com`],
      ),
    );
    await db.withOrganizationScope(ids.org, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name) VALUES($1,$2,'Immutable correction test')`,
        [ids.org, ids.org],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,'OWNER','ACTIVE')`,
        [ids.member, ids.org, ids.user],
      );
      await sql.query(
        `INSERT INTO opes.vendors(id,organization_id,display_name,status,created_by_membership_id) VALUES($1,$2,'Test supplier','VERIFIED',$3)`,
        [ids.vendor, ids.org, ids.member],
      );
      await sql.query(
        `INSERT INTO opes.vendor_payout_addresses(id,organization_id,vendor_id,environment,chain_id,asset_symbol,asset_address,payout_address,status,version,created_by_membership_id) VALUES($1,$2,$3,'arc-testnet',5042002,'USDC','0x3600000000000000000000000000000000000000',$4,'VERIFIED_ACTIVE',1,$5)`,
        [ids.address, ids.org, ids.vendor, vendor, ids.member],
      );
      await sql.query(
        `INSERT INTO opes.evidence_documents(id,organization_id,document_type,filename,content_type,size_bytes,sha256_hex,storage_key,created_by_membership_id) VALUES($1,$2,'INVOICE','test.txt','text/plain',1,$3,$4,$5)`,
        [ids.document, ids.org, hash, `audit/${ids.document}`, ids.member],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligations(id,organization_id,vendor_id,source_reference,obligation_key,created_by_membership_id) VALUES($1,$2,$3,'CORRECTION-TEST',$4,$5)`,
        [ids.obligation, ids.org, ids.vendor, hash, ids.member],
      );
      await sql.query(
        `INSERT INTO opes.payable_obligation_versions(id,organization_id,obligation_id,version,evidence_document_id,vendor_id,vendor_address_id,invoice_number,currency,amount_atomic,amount_decimals,line_items,content_hash,created_by_membership_id) VALUES($1,$2,$3,1,$4,$5,$6,'CORRECTION-TEST','USDC',100,6,'[]',$7,$8)`,
        [
          ids.version,
          ids.org,
          ids.obligation,
          ids.document,
          ids.vendor,
          ids.address,
          hash,
          ids.member,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payment_decisions(id,organization_id,source_type,source_id,source_version_id,decision_version,payment_mode,model_action,derived_action,liquidity_route,route_environment,route_chain_id,route_asset_symbol,amount_atomic,destination_address,vendor_id,vendor_address_id,evidence_bundle_hash,policy_snapshot_hash,context_hash,checks,model_name,model_rationale,prompt_version,evidence_check_version,expires_at,bound_vendor_version,bound_address_version) VALUES($1,$2,'INVOICE',$3,$4,1,'DIRECT','PAY','PAY','OPERATING','arc-testnet',5042002,'USDC',100,$5,$6,$7,$8,$8,$8,'[]','test','test','test','test',now()+interval '1 day',1,1)`,
        [
          ids.decision,
          ids.org,
          ids.obligation,
          ids.version,
          vendor,
          ids.vendor,
          ids.address,
          hash,
        ],
      );
      await sql.query(
        `INSERT INTO opes.payment_executions(id,organization_id,decision_id,source_version_id,decision_hash,idempotency_key,context_hash,amount_atomic,destination_address,route_environment,route_chain_id,route_asset_symbol,vault_address,status,requested_by_membership_id,transaction_hash,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$6,100,$7,'arc-testnet',5042002,'USDC',$8,'CONFIRMED',$9,$5,now())`,
        [
          ids.execution,
          ids.org,
          ids.decision,
          ids.version,
          `0x${hash}`,
          hash,
          vendor,
          vault,
          ids.member,
        ],
      );
    });
  });
  // Immutable financial fixtures deliberately remain in the disposable test database.
  afterAll(async () => {
    await db.onModuleDestroy();
  });
  it('posts one ledger pair for concurrent retries and never exceeds the source payment', async () => {
    const input = {
      type: 'CREDIT_NOTE' as const,
      executionId: ids.execution,
      amountAtomic: '20',
      reason: 'Supplier adjustment',
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.create(context, input, 'same-request'),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    await expect(
      service.create(context, { ...input, amountAtomic: '21' }, 'same-request'),
    ).rejects.toThrow('different request');
    const competing = await Promise.allSettled(
      ['one', 'two'].map((key) =>
        service.create(context, { ...input, amountAtomic: '60' }, key),
      ),
    );
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const totals = await db.withTenant(context, (sql) =>
      sql.query(
        `SELECT count(*)::int AS count,sum(amount_atomic)::text AS amount FROM opes.payment_corrections WHERE organization_id=$1`,
        [ids.org],
      ),
    );
    expect(totals.rows[0]).toEqual({ count: 2, amount: '80' });
    const ledger = await db.withTenant(context, (sql) =>
      sql.query(
        `SELECT count(*)::int AS count,sum(CASE WHEN direction='DEBIT' THEN amount_atomic ELSE -amount_atomic END)::text AS balance FROM opes.ledger_entries WHERE organization_id=$1`,
        [ids.org],
      ),
    );
    expect(ledger.rows[0]).toEqual({ count: 4, balance: '0' });
    await expect(
      db.withTenant(context, (sql) =>
        sql.query(
          `UPDATE opes.payment_corrections SET reason='tampered' WHERE organization_id=$1`,
          [ids.org],
        ),
      ),
    ).rejects.toThrow('immutable');
    const refund = {
      ...input,
      type: 'REFUND' as const,
      creditNoteId: results[0].id,
      amountAtomic: '5',
      transactionHash: `0x${'b'.repeat(64)}`,
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ result: null }));
    const previousRpc = process.env.OPES_RPC_ARC_TESTNET;
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid';
    try {
      await expect(
        service.create(context, refund, 'refund-request'),
      ).rejects.toThrow();
      const before = await db.withTenant(context, (sql) =>
        sql.query(
          `SELECT count(*)::int AS count FROM opes.ledger_entries WHERE organization_id=$1`,
          [ids.org],
        ),
      );
      expect(before.rows[0].count).toBe(4);
      fetchMock.mockImplementation((_url, init) => {
        const { method } = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as { method: string };
        const blockHash = `0x${'c'.repeat(64)}`;
        const result =
          method === 'eth_getTransactionReceipt'
            ? {
                status: '0x1',
                transactionHash: refund.transactionHash,
                blockNumber: '0x64',
                blockHash,
                logs: [
                  {
                    address: '0x3600000000000000000000000000000000000000',
                    topics: [
                      keccak256(
                        stringToHex('Transfer(address,address,uint256)'),
                      ),
                      addressTopic(vendor),
                      addressTopic(vault),
                    ],
                    data: `0x${'5'.padStart(64, '0')}`,
                  },
                ],
              }
            : method === 'eth_chainId'
              ? '0x4cef52'
              : method === 'eth_blockNumber'
                ? '0x100'
                : { hash: blockHash };
        return Promise.resolve(Response.json({ result }));
      });
      const verified = await service.create(context, refund, 'refund-request');
      expect((await service.create(context, refund, 'refund-request')).id).toBe(
        verified.id,
      );
      await expect(
        service.create(context, refund, 'refund-replay'),
      ).rejects.toThrow('already been posted');
      const after = await db.withTenant(context, (sql) =>
        sql.query(
          `SELECT count(*)::int AS count,sum(CASE WHEN direction='DEBIT' THEN amount_atomic ELSE -amount_atomic END)::text AS balance FROM opes.ledger_entries WHERE organization_id=$1`,
          [ids.org],
        ),
      );
      expect(after.rows[0]).toEqual({ count: 6, balance: '0' });
    } finally {
      fetchMock.mockRestore();
      if (previousRpc === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
      else process.env.OPES_RPC_ARC_TESTNET = previousRpc;
    }
  });
});
