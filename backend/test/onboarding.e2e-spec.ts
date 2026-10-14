import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database.service';
import { SessionService } from '../src/session.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('Onboarding with runtime RLS (e2e)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let token: string;
  let organizationId: string;
  const userId = randomUUID();
  const slug = `e2e-${randomUUID()}`;
  const idempotencyKey = randomUUID();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    database = app.get(DatabaseService);
    await database.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users (id,email,display_name,owner_wallet_address)
         VALUES ($1,$2,'Onboarding E2E','0x1111111111111111111111111111111111111111')`,
        [userId, `${userId}@example.com`],
      ),
    );
    token = await app.get(SessionService).createSession(userId);
  });

  it('creates and safely replays onboarding under the non-bypass role', async () => {
    const server = app.getHttpAdapter().getInstance() as App;
    const first = await request(server)
      .post('/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ organizationName: 'Onboarding E2E', organizationSlug: slug })
      .expect(201);
    const firstBody = first.body as unknown as {
      organization: { id: string; slug: string; lifecycleStatus: string };
      membership: { role: string };
      agent: { lifecycleStatus: string };
    };
    organizationId = firstBody.organization.id;
    expect(firstBody).toMatchObject({
      organization: { slug, lifecycleStatus: 'PROVISIONING' },
      membership: { role: 'OWNER' },
      agent: { lifecycleStatus: 'PROVISIONING' },
    });

    const replay = await request(server)
      .post('/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ organizationName: 'Onboarding E2E', organizationSlug: slug })
      .expect(201);
    const replayBody = replay.body as unknown as {
      organization: { id: string };
    };
    expect(replayBody.organization.id).toBe(organizationId);

    const owner = await database.withWorker((sql) =>
      sql.query<{ owner_wallet_address: string }>(
        `SELECT app_user.owner_wallet_address
           FROM opes.organization_memberships membership
           JOIN opes.app_users app_user ON app_user.id=membership.user_id
          WHERE membership.organization_id=$1 AND membership.role='OWNER'`,
        [organizationId],
      ),
    );
    expect(owner.rows[0]?.owner_wallet_address).toBe(
      '0x1111111111111111111111111111111111111111',
    );

    await request(server)
      .post('/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ organizationName: 'Different request', organizationSlug: slug })
      .expect(409);
  });

  afterAll(async () => {
    if (organizationId)
      await database.withOrganizationScope(organizationId, async (sql) => {
        await sql.query(
          'DELETE FROM opes.outbox_events WHERE organization_id=$1',
          [organizationId],
        );
        await sql.query(
          'DELETE FROM opes.tenant_resource_bindings WHERE organization_id=$1',
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
      await sql.query(
        'DELETE FROM opes.global_idempotency_records WHERE idempotency_key=$1',
        [idempotencyKey],
      );
      await sql.query('DELETE FROM opes.user_sessions WHERE user_id=$1', [
        userId,
      ]);
      await sql.query('DELETE FROM opes.app_users WHERE id=$1', [userId]);
    });
    await app.close();
  });
});
