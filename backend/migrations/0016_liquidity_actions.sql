BEGIN;

CREATE TABLE IF NOT EXISTS opes.liquidity_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  action_type text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  provider text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PLANNED',
  source_environment text NOT NULL,
  source_chain_id integer NOT NULL,
  source_asset_symbol text NOT NULL,
  destination_environment text NOT NULL,
  destination_chain_id integer NOT NULL,
  destination_asset_symbol text NOT NULL,
  amount_atomic bigint NOT NULL,
  fee_atomic bigint NOT NULL DEFAULT 0,
  quote_expires_at timestamptz NOT NULL,
  provider_reference text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_reason text,
  requested_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT liquidity_actions_type_check CHECK (
    action_type IN ('GATEWAY_TRANSFER', 'CCTP_TRANSFER')
  ),
  CONSTRAINT liquidity_actions_status_check CHECK (
    status IN ('PLANNED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT liquidity_actions_amount_check CHECK (amount_atomic > 0 AND fee_atomic >= 0),
  CONSTRAINT liquidity_actions_hash_check CHECK (
    idempotency_key ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, requested_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.liquidity_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.liquidity_actions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'liquidity_actions'
      AND policyname = 'liquidity_actions_tenant_isolation'
  ) THEN
    CREATE POLICY liquidity_actions_tenant_isolation
      ON opes.liquidity_actions
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0016_liquidity_actions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
