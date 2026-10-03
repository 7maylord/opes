BEGIN;

CREATE TABLE IF NOT EXISTS opes.payment_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  decision_version integer NOT NULL,
  payment_mode text NOT NULL,
  model_action text NOT NULL,
  derived_action text NOT NULL,
  liquidity_route text NOT NULL,
  route_environment text NOT NULL,
  route_chain_id integer NOT NULL,
  route_asset_symbol text NOT NULL,
  amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL DEFAULT 6,
  destination_address text NOT NULL,
  vendor_id uuid NOT NULL,
  vendor_address_id uuid NOT NULL,
  evidence_bundle_hash text NOT NULL,
  policy_snapshot_hash text NOT NULL,
  context_hash text NOT NULL,
  decision_hash text,
  checks jsonb NOT NULL,
  model_name text NOT NULL,
  model_rationale text NOT NULL,
  prompt_version text NOT NULL,
  evidence_check_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_decisions_source_type_check CHECK (source_type IN ('INVOICE')),
  CONSTRAINT payment_decisions_payment_mode_check CHECK (
    payment_mode IN ('DIRECT', 'MILESTONE_ESCROW', 'RECURRING')
  ),
  CONSTRAINT payment_decisions_action_check CHECK (
    model_action IN ('PAY', 'DELAY', 'ESCALATE', 'REJECT')
      AND derived_action IN ('PAY', 'DELAY', 'ESCALATE', 'REJECT')
  ),
  CONSTRAINT payment_decisions_route_check CHECK (
    liquidity_route IN ('OPERATING', 'GATEWAY', 'CCTP', 'NONE')
  ),
  CONSTRAINT payment_decisions_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT payment_decisions_decimals_check CHECK (amount_decimals = 6),
  CONSTRAINT payment_decisions_hash_check CHECK (
    evidence_bundle_hash ~ '^[0-9a-f]{64}$'
      AND policy_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND context_hash ~ '^[0-9a-f]{64}$'
      AND (decision_hash IS NULL OR decision_hash ~ '^0x[0-9a-f]{64}$')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_type, source_version_id, decision_version),
  FOREIGN KEY (organization_id, source_id)
    REFERENCES opes.payable_obligations (organization_id, id),
  FOREIGN KEY (organization_id, source_version_id)
    REFERENCES opes.payable_obligation_versions (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, vendor_address_id)
    REFERENCES opes.vendor_payout_addresses (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.payment_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_decisions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'payment_decisions'
      AND policyname = 'payment_decisions_tenant_isolation'
  ) THEN
    CREATE POLICY payment_decisions_tenant_isolation
      ON opes.payment_decisions
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0011_payment_decisions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
