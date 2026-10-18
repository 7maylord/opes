BEGIN;

ALTER TABLE opes.escrow_agreements
  ALTER COLUMN status SET DEFAULT 'SETUP_REQUIRED';

INSERT INTO opes.schema_migrations (version)
VALUES ('0043_escrow_setup_default')
ON CONFLICT (version) DO NOTHING;

COMMIT;
