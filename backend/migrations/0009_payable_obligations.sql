BEGIN;

CREATE TABLE IF NOT EXISTS opes.payable_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  source_type text NOT NULL DEFAULT 'INVOICE',
  source_reference text NOT NULL,
  obligation_key text NOT NULL,
  status text NOT NULL DEFAULT 'ACCEPTED',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payable_obligations_source_type_check CHECK (source_type IN ('INVOICE')),
  CONSTRAINT payable_obligations_status_check CHECK (
    status IN ('ACCEPTED', 'BLOCKED', 'CANCELLED')
  ),
  CONSTRAINT payable_obligations_key_check CHECK (obligation_key ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, obligation_key),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.payable_obligation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  version integer NOT NULL,
  evidence_document_id uuid NOT NULL,
  extraction_id uuid,
  vendor_id uuid NOT NULL,
  vendor_address_id uuid NOT NULL,
  invoice_number text NOT NULL,
  currency text NOT NULL,
  amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL,
  line_items jsonb NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACCEPTED',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payable_obligation_versions_status_check CHECK (
    status IN ('ACCEPTED', 'REJECTED')
  ),
  CONSTRAINT payable_obligation_versions_decimals_check CHECK (amount_decimals = 6),
  CONSTRAINT payable_obligation_versions_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT payable_obligation_versions_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, obligation_id, version),
  UNIQUE (organization_id, content_hash),
  FOREIGN KEY (organization_id, obligation_id)
    REFERENCES opes.payable_obligations (organization_id, id),
  FOREIGN KEY (organization_id, evidence_document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, extraction_id)
    REFERENCES opes.document_extractions (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, vendor_address_id)
    REFERENCES opes.vendor_payout_addresses (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.payable_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payable_obligations FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.payable_obligation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payable_obligation_versions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payable_obligations',
    'payable_obligation_versions'
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
VALUES ('0009_payable_obligations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
