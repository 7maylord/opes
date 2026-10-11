BEGIN;

ALTER TABLE opes.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_event_type_check;
ALTER TABLE opes.ledger_entries ADD CONSTRAINT ledger_entries_event_type_check CHECK (ledger_event_type IN (
  'INVOICE_ACCEPTED','PAYMENT_SETTLED','RECURRING_PAYMENT_SETTLED','LIQUIDITY_SETTLED','LIQUIDITY_SWAP_SETTLED',
  'LIQUIDITY_FEE','ESCROW_FUNDED','ESCROW_MILESTONE_RELEASED','ESCROW_REFUNDED','USDC_RECOVERED','SPONSOR_GAS_SPENT'
));
ALTER TABLE opes.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_asset_check;
ALTER TABLE opes.ledger_entries ADD CONSTRAINT ledger_entries_asset_check CHECK (asset_symbol IN ('USDC','USDT','ARC_NATIVE'));

CREATE TABLE opes.chain_reconciliation_cursors (
  organization_id uuid NOT NULL,
  environment text NOT NULL,
  chain_id bigint NOT NULL,
  last_finalized_block bigint NOT NULL DEFAULT 0,
  last_finalized_block_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, environment)
);
CREATE TABLE opes.chain_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, environment text NOT NULL, chain_id bigint NOT NULL,
  block_number bigint NOT NULL, block_hash text NOT NULL, transaction_hash text NOT NULL, log_index integer NOT NULL,
  asset_symbol text NOT NULL, from_address text NOT NULL, to_address text NOT NULL, amount_atomic numeric(78,0) NOT NULL,
  status text NOT NULL DEFAULT 'FINALIZED', matched_ledger_entry_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,chain_id,transaction_hash,log_index), CHECK(status IN ('FINALIZED','REORGED')), CHECK(amount_atomic>0)
);
CREATE TABLE opes.treasury_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, exception_type text NOT NULL, movement_id uuid,
  dedupe_key text NOT NULL, status text NOT NULL DEFAULT 'OPEN', details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  UNIQUE(organization_id,exception_type,dedupe_key), CHECK(status IN ('OPEN','RESOLVED'))
);
CREATE TABLE opes.treasury_balance_snapshots (
  organization_id uuid NOT NULL, environment text NOT NULL, address text NOT NULL, asset_symbol text NOT NULL,
  block_number bigint NOT NULL, balance_atomic numeric(78,0) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,environment,address,asset_symbol,block_number)
);

ALTER TABLE opes.chain_reconciliation_cursors ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.chain_reconciliation_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.chain_movements ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.chain_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_exceptions ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.treasury_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.treasury_balance_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.treasury_balance_snapshots FORCE ROW LEVEL SECURITY;
DO $$ DECLARE table_name text; BEGIN FOREACH table_name IN ARRAY ARRAY['chain_reconciliation_cursors','chain_movements','treasury_exceptions','treasury_balance_snapshots'] LOOP
  EXECUTE format('CREATE POLICY %I_tenant_isolation ON opes.%I USING (organization_id=opes.current_organization_id()) WITH CHECK (organization_id=opes.current_organization_id())',table_name,table_name);
  EXECUTE format('CREATE POLICY %I_worker_access ON opes.%I USING (current_setting(''opes.worker'',true)=''true'') WITH CHECK (current_setting(''opes.worker'',true)=''true'')',table_name,table_name);
END LOOP; END $$;
INSERT INTO opes.schema_migrations(version) VALUES('0026_treasury_reconciliation') ON CONFLICT DO NOTHING;
COMMIT;
