import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import type { ActionRow } from './recurring-execution.service';

export async function claimLifecycleAction(
  db: TenantDatabase,
  types: string[],
  id?: string,
): Promise<ActionRow | undefined> {
  const result = await db.query<ActionRow>(
    `WITH candidate AS (
       SELECT action.id FROM opes.lifecycle_chain_actions action
       LEFT JOIN opes.lifecycle_chain_actions required ON required.organization_id=action.organization_id AND required.id=(action.payload->>'requiresActionId')::uuid
       WHERE action.actor='OPERATOR' AND action.action_type=ANY($1::text[])
         AND action.status IN ('PREPARED','SUBMITTED') AND action.next_attempt_at<=now()
         AND (action.lease_expires_at IS NULL OR action.lease_expires_at<=now())
         AND ($2::uuid IS NULL OR action.id=$2)
         AND (required.id IS NULL OR required.status='CONFIRMED')
       ORDER BY action.created_at FOR UPDATE OF action SKIP LOCKED LIMIT 1
     ) UPDATE opes.lifecycle_chain_actions action
       SET claim_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',updated_at=now()
       FROM candidate WHERE action.id=candidate.id RETURNING action.*`,
    [types, id ?? null],
  );
  return result.rows[0];
}

export async function lockLifecycleClaim(
  db: TenantDatabase,
  action: ActionRow,
): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM opes.lifecycle_chain_actions WHERE id=$1 AND claim_token=$2
       AND lease_expires_at>now() AND status IN ('PREPARED','SUBMITTED','UNKNOWN') FOR UPDATE`,
    [action.id, action.claim_token],
  );
  return result.rows.length === 1;
}

export async function releaseLifecycleClaim(
  database: DatabaseService,
  action: ActionRow,
) {
  await database.withWorker((db) =>
    db.query(
      `UPDATE opes.lifecycle_chain_actions SET claim_token=NULL,lease_expires_at=NULL,
       next_attempt_at=now()+interval '10 seconds' WHERE id=$1 AND claim_token=$2`,
      [action.id, action.claim_token],
    ),
  );
}
