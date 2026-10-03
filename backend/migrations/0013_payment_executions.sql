BEGIN;

ALTER TABLE opes.outbox_events
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS opes.payment_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  decision_hash text NOT NULL,
  idempotency_key text NOT NULL,
  context_hash text NOT NULL,
  amount_atomic bigint NOT NULL,
  destination_address text NOT NULL,
  route_environment text NOT NULL,
  route_chain_id integer NOT NULL,
  route_asset_symbol text NOT NULL,
  vault_address text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  failure_reason text,
  requested_by_membership_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_executions_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'CONFIRMED', 'FAILED')
  ),
  CONSTRAINT payment_executions_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT payment_executions_hash_check CHECK (
    decision_hash ~ '^0x[0-9a-f]{64}$'
      AND idempotency_key ~ '^[0-9a-f]{64}$'
      AND context_hash ~ '^[0-9a-f]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, decision_id),
  FOREIGN KEY (organization_id, decision_id)
    REFERENCES opes.payment_decisions (organization_id, id),
  FOREIGN KEY (organization_id, approval_id)
    REFERENCES opes.payment_decision_approvals (organization_id, id),
  FOREIGN KEY (organization_id, source_version_id)
    REFERENCES opes.payable_obligation_versions (organization_id, id),
  FOREIGN KEY (organization_id, requested_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.payment_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_executions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'payment_executions'
      AND policyname = 'payment_executions_tenant_isolation'
  ) THEN
    CREATE POLICY payment_executions_tenant_isolation
      ON opes.payment_executions
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'payment_executions'
      AND policyname = 'payment_executions_worker_access'
  ) THEN
    CREATE POLICY payment_executions_worker_access
      ON opes.payment_executions
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0013_payment_executions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
