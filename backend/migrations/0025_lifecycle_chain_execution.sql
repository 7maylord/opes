BEGIN;

ALTER TABLE opes.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE opes.subscriptions
  ADD COLUMN IF NOT EXISTS mandate_id text,
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD CONSTRAINT subscriptions_status_check CHECK (
    status IN ('SETUP_REQUIRED', 'ACTIVE', 'PAUSED', 'CANCELLED')
  ),
  ADD CONSTRAINT subscriptions_mandate_hash_check CHECK (
    mandate_id IS NULL OR mandate_id ~ '^0x[0-9a-f]{64}$'
  );

ALTER TABLE opes.subscription_cycles DROP CONSTRAINT IF EXISTS subscription_cycles_status_check;
ALTER TABLE opes.subscription_cycles
  ADD COLUMN IF NOT EXISTS cycle_index integer,
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD CONSTRAINT subscription_cycles_status_check CHECK (
    status IN ('DUE', 'PROCESSING', 'PAID', 'BLOCKED', 'CANCELLED', 'FAILED')
  ),
  ADD CONSTRAINT subscription_cycles_index_check CHECK (
    cycle_index IS NULL OR (cycle_index >= 0 AND cycle_index < 24)
  );

ALTER TABLE opes.escrow_agreements DROP CONSTRAINT IF EXISTS escrow_agreements_status_check;
UPDATE opes.escrow_agreements SET status = 'SETUP_REQUIRED' WHERE status = 'ACTIVE';
ALTER TABLE opes.escrow_agreements
  ADD COLUMN IF NOT EXISTS chain_agreement_id text,
  ADD COLUMN IF NOT EXISTS funding_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS completion_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD CONSTRAINT escrow_agreements_status_check CHECK (
    status IN ('SETUP_REQUIRED', 'CREATED', 'FUNDING_APPROVED', 'FUNDED', 'DISPUTED', 'CANCELLED', 'COMPLETED')
  ),
  ADD CONSTRAINT escrow_agreements_chain_id_check CHECK (
    chain_agreement_id IS NULL OR chain_agreement_id ~ '^0x[0-9a-f]{64}$'
  );

ALTER TABLE opes.escrow_milestones DROP CONSTRAINT IF EXISTS escrow_milestones_status_check;
ALTER TABLE opes.escrow_milestones
  ADD COLUMN IF NOT EXISTS transaction_hash text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD CONSTRAINT escrow_milestones_status_check CHECK (
    status IN ('PENDING', 'SUBMITTED', 'ACCEPTED', 'PROCESSING', 'DISPUTED', 'RELEASED', 'REFUNDED', 'FAILED')
  );

CREATE TABLE opes.lifecycle_chain_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  actor text NOT NULL,
  contract_address text NOT NULL,
  call_data text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED',
  provider_transaction_id text,
  transaction_hash text,
  failure_reason text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_chain_actions_actor_check CHECK (actor IN ('OWNER', 'OPERATOR')),
  CONSTRAINT lifecycle_chain_actions_status_check CHECK (
    status IN ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED')
  ),
  CONSTRAINT lifecycle_chain_actions_address_check CHECK (
    contract_address ~ '^0x[0-9a-fA-F]{40}$' AND call_data ~ '^0x[0-9a-fA-F]+$'
  ),
  CONSTRAINT lifecycle_chain_actions_tx_hash_check CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, action_type, target_id),
  UNIQUE (idempotency_key)
);

ALTER TABLE opes.lifecycle_chain_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.lifecycle_chain_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY lifecycle_chain_actions_tenant_isolation ON opes.lifecycle_chain_actions
  USING (organization_id = opes.current_organization_id())
  WITH CHECK (organization_id = opes.current_organization_id());
CREATE POLICY lifecycle_chain_actions_worker_access ON opes.lifecycle_chain_actions
  USING (current_setting('opes.worker', true) = 'true')
  WITH CHECK (current_setting('opes.worker', true) = 'true');

ALTER TABLE opes.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_event_type_check;
ALTER TABLE opes.ledger_entries ADD CONSTRAINT ledger_entries_event_type_check CHECK (
  ledger_event_type IN (
    'INVOICE_ACCEPTED', 'PAYMENT_SETTLED', 'RECURRING_PAYMENT_SETTLED',
    'LIQUIDITY_SETTLED', 'LIQUIDITY_SWAP_SETTLED',
    'ESCROW_FUNDED', 'ESCROW_MILESTONE_RELEASED', 'ESCROW_REFUNDED'
  )
);

INSERT INTO opes.schema_migrations (version)
VALUES ('0025_lifecycle_chain_execution')
ON CONFLICT (version) DO NOTHING;

COMMIT;
