BEGIN;

ALTER TABLE opes.payment_decisions
  ADD COLUMN bound_vendor_version integer,
  ADD COLUMN bound_address_version integer,
  ADD COLUMN proposed_execution_at timestamptz;

UPDATE opes.payment_decisions decision SET
  bound_vendor_version=vendor.version,
  bound_address_version=address.version
FROM opes.vendors vendor,opes.vendor_payout_addresses address
WHERE vendor.organization_id=decision.organization_id
  AND vendor.id=decision.vendor_id
  AND address.organization_id=decision.organization_id
  AND address.id=decision.vendor_address_id;

ALTER TABLE opes.payment_decisions
  ALTER COLUMN bound_vendor_version SET NOT NULL,
  ALTER COLUMN bound_address_version SET NOT NULL;

CREATE TABLE opes.payment_execution_preflights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  status text NOT NULL,
  checks jsonb NOT NULL,
  observed_block_number bigint NOT NULL,
  observed_balance_atomic bigint NOT NULL,
  observed_pending_nonce bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('PASS','BLOCK')),
  CHECK (jsonb_typeof(checks)='array'),
  CHECK (observed_block_number >= 0),
  CHECK (observed_balance_atomic >= 0),
  CHECK (observed_pending_nonce >= 0),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,execution_id),
  FOREIGN KEY (organization_id,execution_id)
    REFERENCES opes.payment_executions(organization_id,id)
);

ALTER TABLE opes.payment_execution_preflights ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_execution_preflights FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_execution_preflights_tenant_isolation
  ON opes.payment_execution_preflights
  USING (organization_id=opes.current_organization_id())
  WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY payment_execution_preflights_worker_access
  ON opes.payment_execution_preflights
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');

INSERT INTO opes.schema_migrations(version)
VALUES ('0038_execution_preflight') ON CONFLICT DO NOTHING;

COMMIT;
