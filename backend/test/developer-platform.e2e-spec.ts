import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/core/auth/session.service';
import { DatabaseService } from '../src/core/database/database.service';
import { recordNotification } from '../src/modules/notifications/notification.service';
jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));
describe('Developer platform (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let session: string;
  const userId = randomUUID(),
    organizationId = randomUUID(),
    membershipId = randomUUID(),
    agentId = randomUUID();
  beforeAll(async () => {
    process.env.OPES_CONNECTOR_ENCRYPTION_KEY = 'a'.repeat(64);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
    db = app.get(DatabaseService);
    await db.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name) VALUES($1,$2,'Developer Owner')`,
        [userId, `developer-${userId}@example.com`],
      ),
    );
    await db.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status) VALUES($1,$2,'Developer Org','ACTIVE')`,
        [organizationId, `developer-${organizationId}`],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,'OWNER','ACTIVE')`,
        [membershipId, organizationId, userId],
      );
      await sql.query(
        `INSERT INTO opes.business_agents(id,organization_id,lifecycle_status) VALUES($1,$2,'ACTIVE')`,
        [agentId, organizationId],
      );
    });
    session = await app.get(SessionService).createSession(userId);
  });
  it('enforces scopes and queues each signed lifecycle event once', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const credential = await request(server)
      .post(`/organizations/${organizationId}/developer/credentials`)
      .set('Authorization', `Bearer ${session}`)
      .send({ name: 'Test', scopes: ['invoices:read'] });
    if (credential.status !== 201)
      throw new Error(
        `credential request failed: ${credential.status} ${JSON.stringify(credential.body as unknown)}`,
      );
    const credentialBody = credential.body as unknown as { secret: string };
    await request(server)
      .get(`/v1/organizations/${organizationId}/invoices`)
      .set('X-OPES-API-Key', credentialBody.secret)
      .expect(200, []);
    await request(server)
      .get(`/v1/organizations/${organizationId}/payments`)
      .set('X-OPES-API-Key', credentialBody.secret)
      .expect(403);
    await request(server)
      .post(`/organizations/${organizationId}/developer/webhooks`)
      .set('Authorization', `Bearer ${session}`)
      .send({
        url: 'https://example.com/opes',
        description: 'Test endpoint',
        eventTypes: ['*'],
      })
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        const endpoint = body as { status: string; signingSecret: string };
        expect(endpoint.status).toBe('ACTIVE');
        expect(endpoint.signingSecret).toMatch(/^whsec_/);
      });
    await db.withOrganizationScope(organizationId, async (sql) => {
      const input = {
        organizationId,
        type: 'PAYMENT_SETTLED',
        priority: 'SUCCESS' as const,
        title: 'Paid',
        body: 'Settled',
        subjectType: 'payment',
        dedupeKey: 'developer-e2e',
      };
      await recordNotification(sql, input);
      await recordNotification(sql, input);
    });
    const deliveries = await request(server)
      .get(`/organizations/${organizationId}/developer/webhook-deliveries`)
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    const deliveryBody = deliveries.body as unknown as Array<
      Record<string, unknown>
    >;
    expect(deliveryBody).toHaveLength(1);
    expect(deliveryBody[0]).toMatchObject({
      eventType: 'PAYMENT_SETTLED',
      status: 'PENDING',
    });
  });
  afterAll(async () => {
    await db.withOrganizationScope(organizationId, async (sql) => {
      for (const table of [
        'webhook_deliveries',
        'webhook_endpoints',
        'api_credentials',
        'workspace_notifications',
        'business_agents',
        'organization_memberships',
      ])
        await sql.query(`DELETE FROM opes.${table} WHERE organization_id=$1`, [
          organizationId,
        ]);
    });
    await db.withOrganizationScope(organizationId, (sql) =>
      sql.query(`DELETE FROM opes.organizations WHERE id=$1`, [organizationId]),
    );
    await db.withDatabase((sql) =>
      sql.query(`DELETE FROM opes.user_sessions WHERE user_id=$1`, [userId]),
    );
    await db.withDatabase((sql) =>
      sql.query(`DELETE FROM opes.app_users WHERE id=$1`, [userId]),
    );
    await app.close();
  });
});
