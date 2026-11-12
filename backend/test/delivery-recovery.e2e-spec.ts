import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/core/database/database.service';
import { WebhookDeliveryWorkerService } from '../src/modules/developers/webhook-delivery-worker.service';
import { NotificationEmailWorkerService } from '../src/modules/notifications/notification-email-worker.service';

interface Claim {
  id: string;
  event_id: string;
  delivery_id: string;
  claim_token: string;
  retry_window_expired: boolean;
}
describe('durable delivery recovery', () => {
  const organizationId = randomUUID(),
    userId = randomUUID(),
    memberId = randomUUID(),
    endpointId = randomUUID();
  let db: DatabaseService;
  beforeAll(async () => {
    db = new DatabaseService();
    await db.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name) VALUES($1,$2,'Delivery test')`,
        [userId, `${userId}@example.com`],
      ),
    );
    await db.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status) VALUES($1,$2,'Delivery test','ACTIVE')`,
        [organizationId, organizationId],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,'OWNER','ACTIVE')`,
        [memberId, organizationId, userId],
      );
      await sql.query(
        `INSERT INTO opes.webhook_endpoints(id,organization_id,url,description,signing_secret_encrypted,event_types,created_by_membership_id) VALUES($1,$2,'https://example.com','test','unused','["*"]',$3)`,
        [endpointId, organizationId, memberId],
      );
    });
  });
  afterAll(async () => {
    await db.withOrganizationScope(organizationId, async (sql) => {
      for (const table of [
        'outbox_events',
        'outbound_email_deliveries',
        'webhook_deliveries',
        'webhook_endpoints',
        'workspace_notifications',
        'organization_memberships',
      ])
        await sql.query(`DELETE FROM opes.${table} WHERE organization_id=$1`, [
          organizationId,
        ]);
      await sql.query('DELETE FROM opes.organizations WHERE id=$1', [
        organizationId,
      ]);
    });
    await db.withDatabase((sql) =>
      sql.query('DELETE FROM opes.app_users WHERE id=$1', [userId]),
    );
    await db.onModuleDestroy();
  });
  it('recovers a webhook after a crash and rejects stale completion/failure writes', async () => {
    const id = randomUUID();
    await db.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `INSERT INTO opes.webhook_deliveries(id,organization_id,endpoint_id,event_key,event_type,payload) VALUES($1,$2,$3,'test','PAYMENT_SETTLED','{}')`,
        [id, organizationId, endpointId],
      ),
    );
    const worker = new WebhookDeliveryWorkerService(db) as unknown as {
      claim(): Promise<Claim | undefined>;
      fail(work: Claim, reason: string): Promise<unknown>;
    };
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => worker.claim()),
    );
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db.withWorker((sql) =>
      sql.query(
        `UPDATE opes.webhook_deliveries SET updated_at=now()-interval '6 minutes' WHERE id=$1`,
        [id],
      ),
    );
    const second = (await worker.claim())!;
    expect(second.claim_token).not.toBe(first.claim_token);
    await worker.fail(first, 'late error');
    const row = await db.withWorker((sql) =>
      sql.query(
        `SELECT status,last_error,attempt_count FROM opes.webhook_deliveries WHERE id=$1`,
        [id],
      ),
    );
    expect(row.rows[0]).toMatchObject({
      status: 'PROCESSING',
      last_error: null,
      attempt_count: 2,
    });
    await db.withWorker((sql) =>
      sql.query(
        `UPDATE opes.webhook_deliveries SET attempt_count=5,updated_at=now()-interval '6 minutes' WHERE id=$1`,
        [id],
      ),
    );
    expect(await worker.claim()).toBeUndefined();
    expect(
      (
        await db.withWorker((sql) =>
          sql.query(`SELECT status FROM opes.webhook_deliveries WHERE id=$1`, [
            id,
          ]),
        )
      ).rows[0].status,
    ).toBe('FAILED');
  });
  it('recovers email claims and stops retrying beyond the provider deduplication window', async () => {
    const id = randomUUID(),
      eventId = randomUUID();
    await db.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.outbound_email_deliveries(id,organization_id,delivery_type,aggregate_id,recipient_email) VALUES($1,$2,'PAYMENT_ADVICE',$3,'test@example.com')`,
        [id, organizationId, randomUUID()],
      );
      await sql.query(
        `INSERT INTO opes.outbox_events(id,organization_id,event_type,aggregate_type,aggregate_id,payload) VALUES($1,$2,'PAYMENT_ADVICE_EMAIL','outbound_email_delivery',$3,'{}')`,
        [eventId, organizationId, id],
      );
    });
    const worker = new NotificationEmailWorkerService(db) as unknown as {
      claim(): Promise<Claim | undefined>;
      failed(event: Claim, reason: string): Promise<unknown>;
    };
    const first = (await worker.claim())!;
    await db.withWorker((sql) =>
      sql.query(
        `UPDATE opes.outbox_events SET updated_at=now()-interval '6 minutes' WHERE id=$1`,
        [eventId],
      ),
    );
    const second = (await worker.claim())!;
    expect(second.claim_token).not.toBe(first.claim_token);
    await worker.failed(first, 'late failure');
    expect(
      (
        await db.withWorker((sql) =>
          sql.query(
            `SELECT status FROM opes.outbound_email_deliveries WHERE id=$1`,
            [id],
          ),
        )
      ).rows[0].status,
    ).toBe('SENDING');
    await db.withWorker(async (sql) => {
      await sql.query(
        `UPDATE opes.outbox_events SET updated_at=now()-interval '6 minutes' WHERE id=$1`,
        [eventId],
      );
      await sql.query(
        `UPDATE opes.outbound_email_deliveries SET first_attempt_at=now()-interval '24 hours' WHERE id=$1`,
        [id],
      );
    });
    const expired = (await worker.claim())!;
    expect(expired.retry_window_expired).toBe(true);
    await worker.failed(expired, 'Provider idempotency window expired');
    expect(
      (
        await db.withWorker((sql) =>
          sql.query(`SELECT status FROM opes.outbox_events WHERE id=$1`, [
            eventId,
          ]),
        )
      ).rows[0].status,
    ).toBe('FAILED');
  });
});
