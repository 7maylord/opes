BEGIN;

CREATE TABLE opes.payment_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  autonomous_limit_atomic bigint NOT NULL,
  single_payment_limit_atomic bigint NOT NULL,
  vendor_daily_limit_atomic bigint NOT NULL,
  organization_daily_limit_atomic bigint NOT NULL,
  monthly_budget_atomic bigint,
  operating_buffer_atomic bigint NOT NULL,
  allowed_routes jsonb NOT NULL,
  allowed_assets jsonb NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('ACTIVE','SUPERSEDED')),
  CHECK (autonomous_limit_atomic > 0),
  CHECK (single_payment_limit_atomic >= autonomous_limit_atomic),
  CHECK (vendor_daily_limit_atomic > 0),
  CHECK (organization_daily_limit_atomic > 0),
  CHECK (monthly_budget_atomic IS NULL OR monthly_budget_atomic > 0),
  CHECK (operating_buffer_atomic >= 0),
  CHECK (jsonb_typeof(allowed_routes)='array'),
  CHECK (jsonb_typeof(allowed_assets)='array'),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,version),
  FOREIGN KEY (organization_id) REFERENCES opes.organizations(id),
  FOREIGN KEY (organization_id,created_by_membership_id)
    REFERENCES opes.organization_memberships(organization_id,id)
);

CREATE UNIQUE INDEX payment_policy_one_active_idx
  ON opes.payment_policy_versions(organization_id) WHERE status='ACTIVE';

CREATE FUNCTION opes.protect_payment_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.organization_id,OLD.version,OLD.autonomous_limit_atomic,
      OLD.single_payment_limit_atomic,OLD.vendor_daily_limit_atomic,
      OLD.organization_daily_limit_atomic,OLD.monthly_budget_atomic,
      OLD.operating_buffer_atomic,OLD.allowed_routes,OLD.allowed_assets,
      OLD.created_by_membership_id,OLD.created_at)
     IS DISTINCT FROM
     (NEW.organization_id,NEW.version,NEW.autonomous_limit_atomic,
      NEW.single_payment_limit_atomic,NEW.vendor_daily_limit_atomic,
      NEW.organization_daily_limit_atomic,NEW.monthly_budget_atomic,
      NEW.operating_buffer_atomic,NEW.allowed_routes,NEW.allowed_assets,
      NEW.created_by_membership_id,NEW.created_at) THEN
    RAISE EXCEPTION 'payment policy versions are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payment_policy_versions_immutable
BEFORE UPDATE ON opes.payment_policy_versions
FOR EACH ROW EXECUTE FUNCTION opes.protect_payment_policy_version();

INSERT INTO opes.payment_policy_versions (
  organization_id,version,autonomous_limit_atomic,single_payment_limit_atomic,
  vendor_daily_limit_atomic,organization_daily_limit_atomic,
  monthly_budget_atomic,operating_buffer_atomic,allowed_routes,allowed_assets
)
SELECT organization.id,1,1000000000,10000000000,25000000000,100000000000,
       settings.monthly_budget_atomic,COALESCE(settings.operating_buffer_atomic,0),
       '["OPERATING:arc-testnet:5042002:USDC","CCTP:base-sepolia:84532:USDC","GATEWAY:base-sepolia:84532:USDC"]'::jsonb,
       '["USDC"]'::jsonb
FROM opes.organizations organization
LEFT JOIN opes.treasury_settings settings ON settings.organization_id=organization.id;

ALTER TABLE opes.payment_decisions ADD COLUMN policy_version_id uuid;
ALTER TABLE opes.payment_decisions ADD CONSTRAINT payment_decisions_policy_version_fk
  FOREIGN KEY (organization_id,policy_version_id)
  REFERENCES opes.payment_policy_versions(organization_id,id);

ALTER TABLE opes.payment_executions ALTER COLUMN approval_id DROP NOT NULL;

ALTER TABLE opes.payment_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_policy_versions_tenant_isolation
  ON opes.payment_policy_versions
  USING (organization_id=opes.current_organization_id())
  WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY payment_policy_versions_worker_access
  ON opes.payment_policy_versions
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');

INSERT INTO opes.schema_migrations(version)
VALUES ('0037_versioned_payment_policies') ON CONFLICT DO NOTHING;

COMMIT;
