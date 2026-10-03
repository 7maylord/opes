BEGIN;

CREATE TABLE IF NOT EXISTS opes.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING',
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_status_check CHECK (
    status IN ('PROCESSING', 'COMPLETED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);

ALTER TABLE opes.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.idempotency_records FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'idempotency_records'
      AND policyname = 'idempotency_records_tenant_isolation'
  ) THEN
    CREATE POLICY idempotency_records_tenant_isolation
      ON opes.idempotency_records
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0004_tenant_idempotency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
