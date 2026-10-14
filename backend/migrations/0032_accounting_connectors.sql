BEGIN;

CREATE TABLE opes.accounting_connector_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  provider text NOT NULL,
  label text NOT NULL,
  base_url text NOT NULL,
  database_name text,
  encrypted_credentials text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  sync_cursor timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_connector_provider_check CHECK (provider IN ('ODOO', 'ERPNEXT')),
  CONSTRAINT accounting_connector_status_check CHECK (status IN ('ACTIVE', 'DISABLED', 'FAILED')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, provider, label),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE opes.external_accounting_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  record_type text NOT NULL,
  external_id text NOT NULL,
  version_hash text NOT NULL,
  provider_updated_at timestamptz,
  normalized_data jsonb NOT NULL,
  raw_data jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_accounting_record_type_check CHECK (
    record_type IN ('VENDOR', 'PURCHASE_ORDER', 'PURCHASE_RECEIPT', 'VENDOR_BILL')
  ),
  CONSTRAINT external_accounting_version_hash_check CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, connector_id, record_type, external_id, version_hash),
  FOREIGN KEY (organization_id, connector_id)
    REFERENCES opes.accounting_connector_bindings (organization_id, id)
);

CREATE INDEX external_accounting_records_lookup_idx
  ON opes.external_accounting_records (
    organization_id, connector_id, record_type, external_id, fetched_at DESC
  );

CREATE TABLE opes.accounting_settlement_writebacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  payment_execution_id uuid NOT NULL,
  external_bill_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  provider_reference text,
  failure_reason text,
  requested_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT accounting_writeback_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, connector_id, payment_execution_id, external_bill_id),
  FOREIGN KEY (organization_id, connector_id)
    REFERENCES opes.accounting_connector_bindings (organization_id, id),
  FOREIGN KEY (organization_id, payment_execution_id)
    REFERENCES opes.payment_executions (organization_id, id),
  FOREIGN KEY (organization_id, requested_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE UNIQUE INDEX accounting_connector_pending_sync_idx
  ON opes.outbox_events (organization_id, aggregate_id)
  WHERE event_type = 'accounting.connector.sync'
    AND status IN ('PENDING', 'PROCESSING');

ALTER TABLE opes.accounting_connector_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.accounting_connector_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.external_accounting_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.external_accounting_records FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.accounting_settlement_writebacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.accounting_settlement_writebacks FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounting_connector_bindings',
    'external_accounting_records',
    'accounting_settlement_writebacks'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON opes.%I USING (organization_id = opes.current_organization_id()) WITH CHECK (organization_id = opes.current_organization_id())',
      table_name, table_name
    );
    EXECUTE format(
      'CREATE POLICY %I_worker_access ON opes.%I USING (current_setting(''opes.worker'', true) = ''true'') WITH CHECK (current_setting(''opes.worker'', true) = ''true'')',
      table_name, table_name
    );
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0032_accounting_connectors')
ON CONFLICT (version) DO NOTHING;

COMMIT;
