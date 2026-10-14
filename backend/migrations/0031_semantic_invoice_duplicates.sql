BEGIN;

ALTER TABLE opes.payable_obligation_versions
  ADD COLUMN IF NOT EXISTS semantic_fingerprint text;
ALTER TABLE opes.payable_obligation_versions
  ADD CONSTRAINT payable_obligation_versions_semantic_fingerprint_check CHECK (
    semantic_fingerprint IS NULL OR semantic_fingerprint ~ '^[0-9a-f]{64}$'
  );
CREATE INDEX IF NOT EXISTS payable_obligation_versions_semantic_fingerprint_idx
  ON opes.payable_obligation_versions (organization_id, semantic_fingerprint)
  WHERE semantic_fingerprint IS NOT NULL;

INSERT INTO opes.schema_migrations (version)
VALUES ('0031_semantic_invoice_duplicates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
