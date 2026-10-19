import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/core/auth/session.service';
import { DatabaseService } from '../src/core/database/database.service';
import { RailwayBucketService } from '../src/infrastructure/storage/railway-bucket.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('Vendor portal (e2e)', () => {
  interface AccessBody {
    id: string;
    token: string;
  }
  interface SubmissionBody {
    id: string;
    rootSubmissionId: string;
    version: number;
    status: string;
  }
  interface InitiatedBody {
    submission: SubmissionBody;
    upload: { document: { storageKey: string } };
  }
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  const userId = randomUUID();
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  const agentId = randomUUID();
  const vendorId = randomUUID();
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; sizeBytes: number }
  >();

  beforeAll(async () => {
    const bucket = {
      isConfigured: () => true,
      createUploadUrl: (key: string) =>
        Promise.resolve({ url: `https://bucket.test/${key}`, headers: {} }),
      read: (key: string) => Promise.resolve(objects.get(key)!),
      finalize: (source: string, destination: string) => {
        objects.set(destination, objects.get(source)!);
        return Promise.resolve();
      },
      delete: (key: string) => {
        objects.delete(key);
        return Promise.resolve();
      },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RailwayBucketService)
      .useValue(bucket)
      .compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
    database = app.get(DatabaseService);
    await database.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name) VALUES ($1,$2,'Portal Owner')`,
        [userId, `portal-${userId}@example.com`],
      ),
    );
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status) VALUES ($1,$2,'Portal Org','ACTIVE')`,
        [organizationId, `portal-${organizationId}`],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships(id,organization_id,user_id,role,status) VALUES ($1,$2,$3,'OWNER','ACTIVE')`,
        [membershipId, organizationId, userId],
      );
      await sql.query(
        `INSERT INTO opes.business_agents(id,organization_id,lifecycle_status) VALUES ($1,$2,'ACTIVE')`,
        [agentId, organizationId],
      );
      await sql.query(
        `INSERT INTO opes.vendors(id,organization_id,display_name,status,created_by_membership_id) VALUES ($1,$2,'Bound Vendor','VERIFIED',$3)`,
        [vendorId, organizationId, membershipId],
      );
    });
    sessionToken = await app.get(SessionService).createSession(userId);
  });

  it('binds, versions and revokes vendor-only submissions without granting treasury authority', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const access = await request(server)
      .post(
        `/organizations/${organizationId}/vendors/${vendorId}/portal-access`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        contactEmail: 'billing@vendor.example',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    const accessBody = access.body as AccessBody;
    const token = accessBody.token;
    await request(server)
      .get(`/vendor-portal/${token}`)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          organizationName: 'Portal Org',
          vendorName: 'Bound Vendor',
          contactEmail: 'billing@vendor.example',
        });
        expect(body).not.toHaveProperty('organizationId');
      });

    const first = await submit(
      server,
      token,
      'invoice-v1.txt',
      'invoice version one',
      undefined,
    );
    const second = await submit(
      server,
      token,
      'invoice-v2.txt',
      'invoice version two',
      first.id,
    );
    const timeline = await request(server)
      .get(`/vendor-portal/${token}/submissions`)
      .expect(200);
    expect(timeline.body as SubmissionBody[]).toMatchObject([
      { id: first.id, version: 1, status: 'SUPERSEDED' },
      {
        id: second.id,
        rootSubmissionId: first.id,
        version: 2,
        status: 'SUBMITTED',
      },
    ]);

    const authority = await database.withOrganizationScope(
      organizationId,
      (sql) =>
        sql.query<{ addresses: string; trusted: boolean }>(
          `SELECT (SELECT count(*)::text FROM opes.vendor_payout_addresses WHERE organization_id=$1) AS addresses,
       bool_and((metadata->'vendorPortal'->>'trustedForVendorOrPayoutAuthority')::boolean) AS trusted
       FROM opes.evidence_documents WHERE organization_id=$1`,
          [organizationId],
        ),
    );
    expect(authority.rows[0]).toEqual({ addresses: '0', trusted: false });

    await request(server)
      .delete(
        `/organizations/${organizationId}/vendors/${vendorId}/portal-access/${accessBody.id}`,
      )
      .set('Authorization', `Bearer ${sessionToken}`)
      .expect(200);
    await request(server).get(`/vendor-portal/${token}`).expect(401);
  });

  async function submit(
    server: App,
    token: string,
    filename: string,
    value: string,
    replacesSubmissionId?: string,
  ): Promise<SubmissionBody> {
    const bytes = Buffer.from(value);
    const sha256Hex = createHash('sha256').update(bytes).digest('hex');
    const initiated = await request(server)
      .post(`/vendor-portal/${token}/submissions/uploads`)
      .set('Idempotency-Key', randomUUID())
      .send({
        documentType: 'INVOICE',
        filename,
        contentType: 'text/plain',
        sizeBytes: bytes.length,
        sha256Hex,
        replacesSubmissionId,
      })
      .expect(201);
    const initiatedBody = initiated.body as InitiatedBody;
    objects.set(initiatedBody.upload.document.storageKey, {
      bytes,
      contentType: 'text/plain',
      sizeBytes: bytes.length,
    });
    return (
      await request(server)
        .post(
          `/vendor-portal/${token}/submissions/${initiatedBody.submission.id}/finalize`,
        )
        .expect(201)
    ).body as SubmissionBody;
  }

  afterAll(async () => {
    await database.withOrganizationScope(organizationId, async (sql) => {
      for (const table of [
        'vendor_portal_submissions',
        'vendor_portal_accesses',
        'audit_events',
        'intake_envelopes',
        'evidence_documents',
        'vendors',
        'business_agents',
        'organization_memberships',
      ])
        await sql.query(`DELETE FROM opes.${table} WHERE organization_id=$1`, [
          organizationId,
        ]);
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
});
