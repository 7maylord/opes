BEGIN;

CREATE TABLE IF NOT EXISTS opes.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW',
  version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendors_status_check CHECK (
    status IN ('PENDING_REVIEW', 'VERIFIED', 'ADDRESS_REVIEW', 'DISABLED')
  ),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.vendor_payout_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  environment text NOT NULL,
  chain_id integer NOT NULL,
  asset_symbol text NOT NULL,
  asset_address text NOT NULL,
  payout_address text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW',
  version integer NOT NULL,
  replaces_address_id uuid,
  verified_by_membership_id uuid,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_payout_addresses_status_check CHECK (
    status IN ('PENDING_REVIEW', 'VERIFIED_ACTIVE', 'SUPERSEDED', 'REJECTED')
  ),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, replaces_address_id)
    REFERENCES opes.vendor_payout_addresses (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id),
  FOREIGN KEY (organization_id, verified_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_payout_addresses_one_active_per_asset
  ON opes.vendor_payout_addresses (
    organization_id,
    vendor_id,
    environment,
    chain_id,
    lower(asset_address)
  )
  WHERE status = 'VERIFIED_ACTIVE';

CREATE TABLE IF NOT EXISTS opes.evidence_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  document_type text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256_hex text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'RECORDED',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_documents_type_check CHECK (
    document_type IN ('INVOICE', 'CONTRACT', 'RECEIPT', 'MILESTONE', 'OTHER')
  ),
  CONSTRAINT evidence_documents_status_check CHECK (status IN ('RECORDED')),
  CONSTRAINT evidence_documents_size_check CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  CONSTRAINT evidence_documents_sha256_check CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sha256_hex),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  schema_name text NOT NULL,
  schema_version text NOT NULL,
  model_provider text NOT NULL,
  model_name text NOT NULL,
  source_sha256_hex text NOT NULL,
  output jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ACCEPTED',
  rejection_reason text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_extractions_status_check CHECK (status IN ('ACCEPTED', 'REJECTED')),
  CONSTRAINT document_extractions_source_sha256_check CHECK (source_sha256_hex ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.vendors FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.vendor_payout_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.vendor_payout_addresses FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.evidence_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.evidence_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.document_extractions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'vendors',
    'vendor_payout_addresses',
    'evidence_documents',
    'document_extractions'
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

INSERT INTO opes.schema_migrations (version)
VALUES ('0008_evidence_and_vendors')
ON CONFLICT (version) DO NOTHING;

COMMIT;
