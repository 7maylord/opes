BEGIN;
ALTER TABLE opes.lifecycle_chain_actions
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opes.lifecycle_chain_actions DROP CONSTRAINT lifecycle_chain_actions_status_check;
ALTER TABLE opes.lifecycle_chain_actions ADD CONSTRAINT lifecycle_chain_actions_status_check
  CHECK (status IN ('PREPARED','SUBMITTED','UNKNOWN','CONFIRMED','FAILED'));
CREATE INDEX lifecycle_chain_actions_due_idx ON opes.lifecycle_chain_actions(next_attempt_at,created_at)
  WHERE actor='OPERATOR' AND status IN ('PREPARED','SUBMITTED');
INSERT INTO opes.schema_migrations(version) VALUES('0046_lifecycle_worker_claims');
COMMIT;
