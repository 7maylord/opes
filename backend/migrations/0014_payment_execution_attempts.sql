BEGIN;

ALTER TABLE opes.payment_executions
  DROP CONSTRAINT IF EXISTS payment_executions_status_check;

ALTER TABLE opes.payment_executions
  ADD CONSTRAINT payment_executions_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN')
  );

ALTER TABLE opes.payment_executions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS call_data text,
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

CREATE TABLE IF NOT EXISTS opes.payment_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  provider text NOT NULL,
  chain_id integer NOT NULL,
  to_address text NOT NULL,
  call_data text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED',
  transaction_hash text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_execution_attempts_status_check CHECK (
    status IN ('PREPARED', 'SUBMITTED', 'UNKNOWN', 'FAILED')
  ),
  CONSTRAINT payment_execution_attempts_hash_check CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
      AND (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, execution_id, attempt_number),
  FOREIGN KEY (organization_id, execution_id)
    REFERENCES opes.payment_executions (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_execution_attempts_transaction_key
  ON opes.payment_execution_attempts (organization_id, lower(transaction_hash))
  WHERE transaction_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS opes.payment_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  execution_id uuid,
  transaction_hash text,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'RECORDED',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_reconciliation_events_status_check CHECK (
    status IN ('RECORDED', 'DUPLICATE', 'REJECTED')
  ),
  CONSTRAINT payment_reconciliation_events_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
      AND (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (provider, external_event_id),
  FOREIGN KEY (organization_id, execution_id)
    REFERENCES opes.payment_executions (organization_id, id)
);

ALTER TABLE opes.payment_execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_execution_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_reconciliation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_reconciliation_events FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payment_execution_attempts',
    'payment_reconciliation_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'opes'
        AND tablename = table_name
        AND policyname = table_name || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON opes.%I USING (organization_id = opes.current_organization_id()) WITH CHECK (organization_id = opes.current_organization_id())',
        table_name || '_tenant_isolation',
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payment_execution_attempts',
    'payment_reconciliation_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'opes'
        AND tablename = table_name
        AND policyname = table_name || '_worker_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON opes.%I USING (current_setting(''opes.worker'', true) = ''true'') WITH CHECK (current_setting(''opes.worker'', true) = ''true'')',
        table_name || '_worker_access',
        table_name
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0014_payment_execution_attempts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
