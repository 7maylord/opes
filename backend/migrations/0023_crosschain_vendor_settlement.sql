BEGIN;

ALTER TABLE opes.payable_obligations
  DROP CONSTRAINT IF EXISTS payable_obligations_status_check;

ALTER TABLE opes.payable_obligations
  ADD CONSTRAINT payable_obligations_status_check CHECK (
    status IN ('ACCEPTED', 'PAID', 'BLOCKED', 'CANCELLED')
  );

ALTER TABLE opes.payment_executions
  ALTER COLUMN vault_address DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'DIRECT_VAULT',
  ADD COLUMN IF NOT EXISTS liquidity_action_id uuid,
  ADD COLUMN IF NOT EXISTS token_address text,
  ADD COLUMN IF NOT EXISTS max_source_debit_atomic bigint,
  ADD COLUMN IF NOT EXISTS refund_address text;

ALTER TABLE opes.payment_executions
  ADD CONSTRAINT payment_executions_mode_check CHECK (
    execution_mode IN ('DIRECT_VAULT', 'CROSSCHAIN_WALLET')
  ),
  ADD CONSTRAINT payment_executions_crosschain_check CHECK (
    (execution_mode = 'DIRECT_VAULT' AND vault_address IS NOT NULL)
    OR
    (execution_mode = 'CROSSCHAIN_WALLET'
      AND liquidity_action_id IS NOT NULL
      AND token_address IS NOT NULL
      AND max_source_debit_atomic >= amount_atomic
      AND refund_address IS NOT NULL)
  ),
  ADD CONSTRAINT payment_executions_liquidity_action_fk
    FOREIGN KEY (organization_id, liquidity_action_id)
    REFERENCES opes.liquidity_actions (organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_executions_liquidity_action_key
  ON opes.payment_executions (organization_id, liquidity_action_id)
  WHERE liquidity_action_id IS NOT NULL;

INSERT INTO opes.schema_migrations (version)
VALUES ('0023_crosschain_vendor_settlement')
ON CONFLICT (version) DO NOTHING;

COMMIT;
