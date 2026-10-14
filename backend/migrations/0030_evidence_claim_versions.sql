BEGIN;

ALTER TABLE opes.evidence_documents
  DROP CONSTRAINT IF EXISTS evidence_documents_size_check;
ALTER TABLE opes.evidence_documents
  ADD CONSTRAINT evidence_documents_size_check CHECK (
    size_bytes > 0 AND size_bytes <= 15728640
  );

CREATE TABLE IF NOT EXISTS opes.document_claim_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  version integer NOT NULL,
  schema_name text NOT NULL,
  claims jsonb NOT NULL,
  provenance jsonb NOT NULL,
  status text NOT NULL,
  confirmed_by_membership_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT document_claim_versions_status_check CHECK (
    status IN ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_id, version),
  FOREIGN KEY (organization_id, document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, extraction_id)
    REFERENCES opes.document_extractions (organization_id, id),
  FOREIGN KEY (organization_id, confirmed_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS document_claim_versions_one_current
  ON opes.document_claim_versions (organization_id, document_id)
  WHERE status IN ('PENDING_REVIEW', 'CONFIRMED');

ALTER TABLE opes.document_claim_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.document_claim_versions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'opes'
       AND tablename = 'document_claim_versions'
       AND policyname = 'document_claim_versions_tenant_isolation'
  ) THEN
    CREATE POLICY document_claim_versions_tenant_isolation
      ON opes.document_claim_versions
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'opes'
       AND tablename = 'document_claim_versions'
       AND policyname = 'document_claim_versions_worker_access'
  ) THEN
    CREATE POLICY document_claim_versions_worker_access
      ON opes.document_claim_versions
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0030_evidence_claim_versions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
