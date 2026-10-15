import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database.service';
import { InvoiceModelService } from '../src/invoice-model.service';
import { RailwayBucketService } from '../src/railway-bucket.service';
import { SessionService } from '../src/session.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('Resend inbound email (e2e)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  const agentId = randomUUID();
  const address = `invoices-${organizationId}@inbound.example`;
  const secret = `whsec_${Buffer.from('resend-e2e-secret-32-bytes-long!!').toString('base64')}`;
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; sizeBytes: number }
  >();
  const originalFetch = global.fetch;
  const originalSecret = process.env.OPES_RESEND_WEBHOOK_SECRET;
  const originalApiKey = process.env.OPES_RESEND_API_KEY;

  beforeAll(async () => {
    process.env.OPES_RESEND_WEBHOOK_SECRET = secret;
    process.env.OPES_RESEND_API_KEY = 're_e2e';
    const bucket = {
      isConfigured: () => true,
      write: (key: string, bytes: Uint8Array, contentType: string) => {
        objects.set(key, { bytes, contentType, sizeBytes: bytes.length });
        return Promise.resolve();
      },
      read: (key: string) => {
        const stored = objects.get(key);
        if (!stored) throw new Error('Object missing');
        return Promise.resolve(stored);
      },
      finalize: (source: string, destination: string) => {
        const stored = objects.get(source);
        if (!stored) throw new Error('Object missing');
        objects.set(destination, stored);
        return Promise.resolve();
      },
      delete: (key: string) => {
        objects.delete(key);
        return Promise.resolve();
      },
    };
    const model = {
      extract: () =>
        Promise.resolve({
          provider: 'deepseek',
          model: 'deepseek-flash',
          responseId: 'response-e2e',
          promptVersion: 'invoice-extraction-v2',
          requestHash: 'a'.repeat(64),
          output: invoiceExtraction(),
        }),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RailwayBucketService)
      .useValue(bucket)
      .overrideProvider(InvoiceModelService)
      .useValue(model)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
    database = app.get(DatabaseService);
    await database.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name)
         VALUES ($1,$2,'Email Tester')`,
        [userId, `email-${userId}@example.com`],
      ),
    );
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status)
         VALUES ($1,$2,'Email Org','ACTIVE')`,
        [organizationId, `email-${organizationId}`],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships
          (id,organization_id,user_id,role,status)
         VALUES ($1,$2,$3,'OWNER','ACTIVE')`,
        [membershipId, organizationId, userId],
      );
      await sql.query(
        `INSERT INTO opes.business_agents(id,organization_id,lifecycle_status)
         VALUES ($1,$2,'ACTIVE')`,
        [agentId, organizationId],
      );
    });
    sessionToken = await app.get(SessionService).createSession(userId);
  });

  it('takes a signed inbound attachment to extraction review idempotently', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    await request(server)
      .put(`/organizations/${organizationId}/email-inbox`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ address })
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ address, status: 'ACTIVE' }),
      );

    const event = receivedEvent(address);
    mockResend(event);
    const signed = sign(event, 'msg_email_e2e');
    await request(server)
      .post('/webhooks/resend/inbound')
      .set(signed.headers)
      .send(signed.raw)
      .expect(200)
      .expect({ status: 'PROCESSED', documents: 1, replay: false });

    await request(server)
      .post('/webhooks/resend/inbound')
      .set(signed.headers)
      .send(signed.raw)
      .expect(200)
      .expect({ status: 'PROCESSED', documents: 1, replay: true });

    const proof = await database.withOrganizationScope(organizationId, (sql) =>
      sql.query<{
        intake_status: string;
        document_status: string;
        review_status: string;
        trusted: boolean;
      }>(
        `SELECT intake.status AS intake_status,document.status AS document_status,
              claim.status AS review_status,
              (document.metadata->'senderEvidence'->>'trustedForVendorOrPayoutAuthority')::boolean AS trusted
           FROM opes.intake_envelopes intake
           JOIN opes.evidence_documents document
             ON document.organization_id=intake.organization_id
            AND document.id=intake.document_id
           JOIN opes.document_extractions extraction
             ON extraction.organization_id=document.organization_id
            AND extraction.document_id=document.id
           JOIN opes.document_claim_versions claim
             ON claim.organization_id=extraction.organization_id
            AND claim.extraction_id=extraction.id
           WHERE intake.organization_id=$1 AND intake.source_type='EMAIL'`,
        [organizationId],
      ),
    );
    expect(proof.rows).toEqual([
      {
        intake_status: 'VERIFIED',
        document_status: 'VERIFIED',
        review_status: 'PENDING_REVIEW',
        trusted: false,
      },
    ]);

    await request(server)
      .get(`/organizations/${organizationId}/email-inbox/events`)
      .set('authorization', `Bearer ${sessionToken}`)
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toEqual([
          expect.objectContaining({
            senderAddress: 'billing@vendor.example',
            subject: 'Invoice E2E',
            status: 'PROCESSED',
            documentCount: 1,
            documents: [
              expect.objectContaining({
                filename: 'invoice.txt',
                status: 'VERIFIED',
              }),
            ],
          }),
        ]),
      );

    await request(server)
      .post('/webhooks/resend/inbound')
      .set({ ...signed.headers, 'svix-signature': 'v1,Zm9yZ2Vk' })
      .send(signed.raw)
      .expect(401);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (originalSecret === undefined)
      delete process.env.OPES_RESEND_WEBHOOK_SECRET;
    else process.env.OPES_RESEND_WEBHOOK_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.OPES_RESEND_API_KEY;
    else process.env.OPES_RESEND_API_KEY = originalApiKey;
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        'DELETE FROM opes.audit_events WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.document_claim_versions WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.document_extractions WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.intake_envelopes WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.evidence_documents WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.inbound_email_events WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.email_inboxes WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.business_agents WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query(
        'DELETE FROM opes.organization_memberships WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query('DELETE FROM opes.organizations WHERE id=$1', [
        organizationId,
      ]);
    });
    await database.withDatabase(async (sql) => {
      await sql.query('DELETE FROM opes.user_sessions WHERE user_id=$1', [
        userId,
      ]);
      await sql.query('DELETE FROM opes.app_users WHERE id=$1', [userId]);
    });
    await app.close();
  });

  function mockResend(event: ReturnType<typeof receivedEvent>) {
    global.fetch = jest.fn((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === 'https://attachments.example/invoice')
        return Promise.resolve(
          new Response('vendor invoice 1', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        );
      if (url.endsWith('/attachments/77777777-7777-4777-8777-777777777777'))
        return Promise.resolve(
          Response.json({
            ...event.data.attachments[0],
            download_url: 'https://attachments.example/invoice',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      return Promise.resolve(
        Response.json({
          id: event.data.email_id,
          from: event.data.from,
          to: event.data.to,
          message_id: event.data.message_id,
          subject: event.data.subject,
          headers: { 'Authentication-Results': 'spf=pass; dkim=pass' },
          attachments: event.data.attachments,
        }),
      );
    }) as typeof fetch;
  }

  function sign(value: unknown, id: string) {
    const raw = JSON.stringify(value);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac(
      'sha256',
      Buffer.from(secret.slice(6), 'base64'),
    )
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');
    return {
      raw,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      },
    };
  }
});

function receivedEvent(address: string) {
  return {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: '66666666-6666-4666-8666-666666666666',
      created_at: new Date().toISOString(),
      from: 'Vendor Billing <billing@vendor.example>',
      to: [address],
      bcc: [],
      cc: [],
      message_id: '<invoice-e2e@vendor.example>',
      subject: 'Invoice E2E',
      attachments: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          filename: 'invoice.txt',
          content_type: 'text/plain',
          content_disposition: 'attachment',
          content_id: null,
        },
      ],
    },
  };
}

function invoiceExtraction() {
  const fields = [
    'vendorName',
    'invoiceNumber',
    'issueDate',
    'dueDate',
    'currency',
    'amount',
    'payoutAddress',
    'purchaseOrderReference',
    'milestoneReference',
    'lineItems',
  ];
  return {
    vendorName: 'Vendor',
    invoiceNumber: 'INV-EMAIL-1',
    issueDate: '2026-10-15',
    dueDate: '2026-10-30',
    currency: 'USDC',
    amount: '1.00',
    payoutAddress: null,
    purchaseOrderReference: 'PO-1',
    milestoneReference: null,
    lineItems: [{ description: 'Service', amount: '1.00' }],
    confidence: 80,
    warnings: [],
    provenance: Object.fromEntries(
      fields.map((field) => [
        field,
        { page: 1, excerpt: field, confidence: 80 },
      ]),
    ),
  };
}
