BEGIN;

CREATE TABLE opes.vendor_portal_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  contact_email text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT vendor_portal_access_status_check CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT vendor_portal_access_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id) REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE opes.vendor_portal_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  access_id uuid NOT NULL,
  document_id uuid NOT NULL,
  root_submission_id uuid,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADING',
  vendor_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CONSTRAINT vendor_portal_submission_status_check CHECK (
    status IN ('UPLOADING', 'SUBMITTED', 'SUPERSEDED', 'REJECTED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_id),
  UNIQUE (organization_id, root_submission_id, version),
  FOREIGN KEY (organization_id, vendor_id) REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, access_id) REFERENCES opes.vendor_portal_accesses (organization_id, id),
  FOREIGN KEY (organization_id, document_id) REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, root_submission_id) REFERENCES opes.vendor_portal_submissions (organization_id, id)
);

ALTER TABLE opes.vendor_portal_accesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.vendor_portal_accesses FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.vendor_portal_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.vendor_portal_submissions FORCE ROW LEVEL SECURITY;

CREATE POLICY vendor_portal_accesses_tenant_isolation ON opes.vendor_portal_accesses
  USING (organization_id = opes.current_organization_id())
  WITH CHECK (organization_id = opes.current_organization_id());
CREATE POLICY vendor_portal_accesses_worker_access ON opes.vendor_portal_accesses
  USING (current_setting('opes.worker', true) = 'true')
  WITH CHECK (current_setting('opes.worker', true) = 'true');
CREATE POLICY vendor_portal_submissions_tenant_isolation ON opes.vendor_portal_submissions
  USING (organization_id = opes.current_organization_id())
  WITH CHECK (organization_id = opes.current_organization_id());

INSERT INTO opes.schema_migrations (version) VALUES ('0040_vendor_portal');
COMMIT;
