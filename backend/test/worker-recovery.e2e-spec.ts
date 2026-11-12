import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/core/database/database.service';
import {
  claimLifecycleAction,
  lockLifecycleClaim,
} from '../src/modules/agreements/lifecycle-action-claims';

describe('worker ownership under concurrent PostgreSQL transactions', () => {
  const organizationId = randomUUID();
  let db: DatabaseService;
  beforeAll(async () => {
    db = new DatabaseService();
    await db.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status) VALUES($1,$2,'Worker race test','ACTIVE')`,
        [organizationId, `race-${organizationId}`],
      ),
    );
  });
  afterAll(async () => {
    await db.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        'DELETE FROM opes.lifecycle_chain_actions WHERE organization_id=$1',
        [organizationId],
      );
      await sql.query('DELETE FROM opes.organizations WHERE id=$1', [
        organizationId,
      ]);
    });
    await db.onModuleDestroy();
  });
  it('allows one claimant, recovers an expired lease, and fences the abandoned worker', async () => {
    const id = randomUUID();
    await db.withOrganizationScope(organizationId, (sql) =>
      sql.query(
        `INSERT INTO opes.lifecycle_chain_actions(id,organization_id,action_type,target_type,target_id,actor,contract_address,call_data,idempotency_key)
       VALUES($1,$2,'EXECUTE_RECURRING_PAYMENT','subscription_cycle',$3,'OPERATOR',$4,'0x1234',$5)`,
        [id, organizationId, randomUUID(), `0x${'1'.repeat(40)}`, randomUUID()],
      ),
    );
    const claims = await Promise.all(
      Array.from({ length: 40 }, () =>
        db.withWorker((sql) =>
          claimLifecycleAction(sql, ['EXECUTE_RECURRING_PAYMENT'], id),
        ),
      ),
    );
    const winners = claims.filter((action) => action !== undefined);
    expect(winners).toHaveLength(1);
    const first = winners[0];
    await db.withWorker((sql) =>
      sql.query(
        `UPDATE opes.lifecycle_chain_actions SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        [id],
      ),
    );
    const second = await db.withWorker((sql) =>
      claimLifecycleAction(sql, ['EXECUTE_RECURRING_PAYMENT'], id),
    );
    expect(second?.claim_token).not.toBe(first.claim_token);
    expect(await db.withWorker((sql) => lockLifecycleClaim(sql, first))).toBe(
      false,
    );
    expect(await db.withWorker((sql) => lockLifecycleClaim(sql, second!))).toBe(
      true,
    );
    await db.withWorker((sql) =>
      sql.query(
        `UPDATE opes.lifecycle_chain_actions SET status='UNKNOWN',lease_expires_at=NULL WHERE id=$1`,
        [id],
      ),
    );
    expect(
      await db.withWorker((sql) =>
        claimLifecycleAction(sql, ['EXECUTE_RECURRING_PAYMENT'], id),
      ),
    ).toBeUndefined();
  });
});
