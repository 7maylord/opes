BEGIN;

CREATE TABLE IF NOT EXISTS opes.intake_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  source_type text NOT NULL,
  source_event_id text NOT NULL,
  payload_hash text NOT NULL,
  document_id uuid,
  status text NOT NULL DEFAULT 'RECEIVED',
  quarantine_reason text,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_envelopes_source_type_check CHECK (
    source_type IN (
      'MANUAL_UPLOAD', 'EMAIL', 'VENDOR_PORTAL', 'WATCHED_BUCKET',
      'ODOO', 'ERPNEXT'
    )
  ),
  CONSTRAINT intake_envelopes_status_check CHECK (
    status IN ('RECEIVED', 'STAGED', 'VERIFIED', 'QUARANTINED', 'FAILED')
  ),
  CONSTRAINT intake_envelopes_payload_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_type, source_event_id),
  FOREIGN KEY (organization_id, document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE INDEX IF NOT EXISTS intake_envelopes_status_received_idx
  ON opes.intake_envelopes (organization_id, status, received_at);

ALTER TABLE opes.intake_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.intake_envelopes FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'opes'
       AND tablename = 'intake_envelopes'
       AND policyname = 'intake_envelopes_tenant_isolation'
  ) THEN
    CREATE POLICY intake_envelopes_tenant_isolation
      ON opes.intake_envelopes
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'opes'
       AND tablename = 'intake_envelopes'
       AND policyname = 'intake_envelopes_worker_access'
  ) THEN
    CREATE POLICY intake_envelopes_worker_access
      ON opes.intake_envelopes
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0029_canonical_evidence_intake')
ON CONFLICT (version) DO NOTHING;

COMMIT;
