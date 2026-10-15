BEGIN;

CREATE TABLE opes.watched_bucket_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES opes.organizations(id),
  source_key text NOT NULL UNIQUE,
  etag text NOT NULL,
  size_bytes bigint NOT NULL,
  last_modified timestamptz NOT NULL,
  content_type text,
  document_type text,
  document_id uuid,
  status text NOT NULL DEFAULT 'OBSERVED',
  quarantine_reason text,
  failure_reason text,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watched_bucket_status_check CHECK (status IN ('OBSERVED','PROCESSING','PROCESSED','QUARANTINED','FAILED')),
  CONSTRAINT watched_bucket_size_check CHECK (size_bytes >= 0),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,document_id) REFERENCES opes.evidence_documents(organization_id,id)
);

CREATE TABLE opes.watched_bucket_cursors (
  prefix text PRIMARY KEY,
  continuation_token text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE opes.watched_bucket_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.watched_bucket_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.watched_bucket_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.watched_bucket_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY watched_bucket_objects_worker_access ON opes.watched_bucket_objects
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');
CREATE POLICY watched_bucket_objects_tenant_isolation ON opes.watched_bucket_objects
  USING (organization_id=opes.current_organization_id())
  WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY watched_bucket_cursors_worker_access ON opes.watched_bucket_cursors
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');

INSERT INTO opes.schema_migrations(version) VALUES ('0041_watched_bucket');
COMMIT;
