BEGIN;

ALTER TABLE opes.liquidity_actions
  DROP CONSTRAINT IF EXISTS liquidity_actions_status_check;

ALTER TABLE opes.liquidity_actions
  ADD CONSTRAINT liquidity_actions_status_check CHECK (
    status IN ('PLANNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'CANCELLED')
  );

ALTER TABLE opes.liquidity_actions
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

INSERT INTO opes.schema_migrations (version)
VALUES ('0017_liquidity_submission')
ON CONFLICT (version) DO NOTHING;

COMMIT;
