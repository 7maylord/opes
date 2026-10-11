BEGIN;

ALTER TABLE opes.evidence_documents
  DROP CONSTRAINT IF EXISTS evidence_documents_status_check;

UPDATE opes.evidence_documents
   SET status = 'LEGACY_METADATA'
 WHERE status = 'RECORDED';

ALTER TABLE opes.evidence_documents
  ALTER COLUMN status SET DEFAULT 'STAGING',
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE opes.evidence_documents
  ADD CONSTRAINT evidence_documents_status_check CHECK (
    status IN ('STAGING', 'VERIFIED', 'LEGACY_METADATA')
  );

ALTER TABLE opes.document_extractions
  ADD COLUMN IF NOT EXISTS provider_response_id text,
  ADD COLUMN IF NOT EXISTS prompt_version text,
  ADD COLUMN IF NOT EXISTS request_hash text;

ALTER TABLE opes.document_extractions
  ADD CONSTRAINT document_extractions_request_hash_check CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS document_extractions_model_run_key
  ON opes.document_extractions (
    organization_id,
    document_id,
    schema_name,
    schema_version,
    model_provider,
    model_name,
    source_sha256_hex
  );

INSERT INTO opes.schema_migrations (version)
VALUES ('0024_verified_document_storage')
ON CONFLICT (version) DO NOTHING;

COMMIT;
