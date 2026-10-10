BEGIN;

ALTER TABLE opes.payment_execution_attempts
  ADD COLUMN IF NOT EXISTS provider_transaction_id text;

ALTER TABLE opes.payment_execution_attempts
  DROP CONSTRAINT IF EXISTS payment_execution_attempts_status_check;

ALTER TABLE opes.payment_execution_attempts
  ADD CONSTRAINT payment_execution_attempts_status_check CHECK (
    status IN ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN', 'FAILED')
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_execution_attempts_request_key
  ON opes.payment_execution_attempts (organization_id, execution_id, request_hash);

CREATE UNIQUE INDEX IF NOT EXISTS payment_execution_attempts_provider_transaction_key
  ON opes.payment_execution_attempts (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_active_operator_wallet_key
  ON opes.tenant_resource_bindings (organization_id, provider, environment, resource_type)
  WHERE status = 'ACTIVE' AND resource_type = 'operator_wallet';

INSERT INTO opes.schema_migrations (version)
VALUES ('0022_circle_payment_execution')
ON CONFLICT (version) DO NOTHING;

COMMIT;
