BEGIN;

ALTER TABLE opes.payable_obligation_versions
  ADD COLUMN due_at timestamptz;

CREATE TABLE opes.treasury_settings (
  organization_id uuid PRIMARY KEY,
  operating_buffer_atomic bigint NOT NULL DEFAULT 0,
  monthly_budget_atomic bigint,
  max_snapshot_age_seconds integer NOT NULL DEFAULT 300,
  updated_by_membership_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (operating_buffer_atomic >= 0),
  CHECK (monthly_budget_atomic IS NULL OR monthly_budget_atomic > 0),
  CHECK (max_snapshot_age_seconds BETWEEN 30 AND 3600),
  FOREIGN KEY (organization_id) REFERENCES opes.organizations(id),
  FOREIGN KEY (organization_id, updated_by_membership_id)
    REFERENCES opes.organization_memberships(organization_id,id)
);

CREATE TABLE opes.treasury_balance_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  environment text NOT NULL,
  status text NOT NULL,
  block_number bigint,
  failure_reason text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('SUCCESS','FAILED')),
  CHECK ((status='SUCCESS' AND block_number IS NOT NULL AND failure_reason IS NULL)
      OR (status='FAILED' AND failure_reason IS NOT NULL)),
  UNIQUE (organization_id,id)
);

CREATE INDEX treasury_balance_reads_latest_idx
  ON opes.treasury_balance_reads(organization_id,environment,observed_at DESC);

CREATE TABLE opes.treasury_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  asset_symbol text NOT NULL DEFAULT 'USDC',
  amount_atomic bigint NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (asset_symbol='USDC'),
  CHECK (amount_atomic > 0),
  CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,decision_id),
  FOREIGN KEY (organization_id,decision_id)
    REFERENCES opes.payment_decisions(organization_id,id),
  FOREIGN KEY (organization_id,source_version_id)
    REFERENCES opes.payable_obligation_versions(organization_id,id)
);

CREATE UNIQUE INDEX treasury_reservations_one_active_source_idx
  ON opes.treasury_reservations(organization_id,source_version_id)
  WHERE status='ACTIVE';

ALTER TABLE opes.treasury_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_balance_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_balance_reads FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_reservations FORCE ROW LEVEL SECURITY;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'treasury_settings','treasury_balance_reads','treasury_reservations'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON opes.%I USING (organization_id=opes.current_organization_id()) WITH CHECK (organization_id=opes.current_organization_id())',
      table_name,table_name
    );
    EXECUTE format(
      'CREATE POLICY %I_worker_access ON opes.%I USING (current_setting(''opes.worker'',true)=''true'') WITH CHECK (current_setting(''opes.worker'',true)=''true'')',
      table_name,table_name
    );
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations(version)
VALUES ('0036_treasury_truth') ON CONFLICT DO NOTHING;

COMMIT;
