BEGIN;

ALTER TABLE opes.payable_obligations DROP CONSTRAINT payable_obligations_status_check;
ALTER TABLE opes.payable_obligations ADD CONSTRAINT payable_obligations_status_check CHECK (
  status IN ('PENDING_MATCH', 'ACCEPTED', 'PAID', 'BLOCKED', 'CANCELLED')
);
ALTER TABLE opes.payable_obligation_versions DROP CONSTRAINT payable_obligation_versions_status_check;
ALTER TABLE opes.payable_obligation_versions ADD CONSTRAINT payable_obligation_versions_status_check CHECK (
  status IN ('PENDING_MATCH', 'ACCEPTED', 'BLOCKED', 'REJECTED')
);

CREATE TABLE opes.procurement_evidence_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  evidence_type text NOT NULL,
  vendor_id uuid NOT NULL,
  source_reference text NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_evidence_type_check CHECK (
    evidence_type IN ('PURCHASE_ORDER', 'CONTRACT', 'PURCHASE_RECEIPT', 'SERVICE_ACCEPTANCE')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, evidence_type, source_reference),
  FOREIGN KEY (organization_id, vendor_id) REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE opes.procurement_evidence_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  currency text NOT NULL,
  total_amount_atomic bigint NOT NULL,
  tolerance_bps integer NOT NULL DEFAULT 0,
  line_items jsonb NOT NULL,
  governing_source_id uuid,
  evidence_document_id uuid,
  external_accounting_record_id uuid,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_evidence_status_check CHECK (status IN ('ACTIVE', 'REVOKED', 'CANCELLED')),
  CONSTRAINT procurement_evidence_currency_check CHECK (currency = 'USDC'),
  CONSTRAINT procurement_evidence_amount_check CHECK (total_amount_atomic > 0),
  CONSTRAINT procurement_evidence_tolerance_check CHECK (tolerance_bps BETWEEN 0 AND 10000),
  CONSTRAINT procurement_evidence_provenance_check CHECK (
    num_nonnulls(evidence_document_id, external_accounting_record_id) = 1
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_id, version),
  FOREIGN KEY (organization_id, source_id)
    REFERENCES opes.procurement_evidence_sources (organization_id, id),
  FOREIGN KEY (organization_id, governing_source_id)
    REFERENCES opes.procurement_evidence_sources (organization_id, id),
  FOREIGN KEY (organization_id, evidence_document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, external_accounting_record_id)
    REFERENCES opes.external_accounting_records (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE opes.payable_evidence_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_version_id uuid NOT NULL,
  governing_evidence_version_id uuid NOT NULL,
  delivery_evidence_version_id uuid NOT NULL,
  status text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculation_snapshot jsonb NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payable_evidence_match_status_check CHECK (status IN ('PASS', 'BLOCKED')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_version_id)
    REFERENCES opes.payable_obligation_versions (organization_id, id),
  FOREIGN KEY (organization_id, governing_evidence_version_id)
    REFERENCES opes.procurement_evidence_versions (organization_id, id),
  FOREIGN KEY (organization_id, delivery_evidence_version_id)
    REFERENCES opes.procurement_evidence_versions (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE UNIQUE INDEX payable_evidence_one_pass_idx
  ON opes.payable_evidence_matches (organization_id, invoice_version_id)
  WHERE status = 'PASS';

ALTER TABLE opes.procurement_evidence_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.procurement_evidence_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.procurement_evidence_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.procurement_evidence_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.payable_evidence_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payable_evidence_matches FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'procurement_evidence_sources', 'procurement_evidence_versions', 'payable_evidence_matches'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON opes.%I USING (organization_id=opes.current_organization_id()) WITH CHECK (organization_id=opes.current_organization_id())',
      table_name, table_name
    );
    EXECUTE format(
      'CREATE POLICY %I_worker_access ON opes.%I USING (current_setting(''opes.worker'',true)=''true'') WITH CHECK (current_setting(''opes.worker'',true)=''true'')',
      table_name, table_name
    );
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations(version)
VALUES ('0035_payable_evidence_matching')
ON CONFLICT (version) DO NOTHING;

COMMIT;
