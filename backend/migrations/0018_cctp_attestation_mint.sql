BEGIN;

ALTER TABLE opes.liquidity_actions
  DROP CONSTRAINT IF EXISTS liquidity_actions_status_check;

ALTER TABLE opes.liquidity_actions
  ADD CONSTRAINT liquidity_actions_status_check CHECK (
    status IN (
      'PLANNED',
      'SUBMITTED',
      'ATTESTED',
      'MINTED',
      'CONFIRMED',
      'FAILED',
      'UNKNOWN',
      'CANCELLED'
    )
  );

INSERT INTO opes.schema_migrations (version)
VALUES ('0018_cctp_attestation_mint')
ON CONFLICT (version) DO NOTHING;

COMMIT;
