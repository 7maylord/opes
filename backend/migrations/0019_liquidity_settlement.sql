BEGIN;

ALTER TABLE opes.liquidity_actions
  DROP CONSTRAINT IF EXISTS liquidity_actions_status_check;

ALTER TABLE opes.liquidity_actions
  ADD CONSTRAINT liquidity_actions_status_check CHECK (
    status IN (
      'PLANNED',
      'SUBMITTED',
      'ATTESTED',
      'MINTED',
      'SWAP_SUBMITTED',
      'SWAPPED',
      'CONFIRMED',
      'FAILED',
      'UNKNOWN',
      'CANCELLED'
    )
  );

ALTER TABLE opes.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_event_type_check;

ALTER TABLE opes.ledger_entries
  ADD CONSTRAINT ledger_entries_event_type_check CHECK (
    ledger_event_type IN (
      'INVOICE_ACCEPTED',
      'PAYMENT_SETTLED',
      'LIQUIDITY_SETTLED',
      'LIQUIDITY_SWAP_SETTLED'
    )
  );

ALTER TABLE opes.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_asset_check;

ALTER TABLE opes.ledger_entries
  ADD CONSTRAINT ledger_entries_asset_check CHECK (asset_symbol IN ('USDC', 'USDT'));

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_liquidity_settlement_once
  ON opes.ledger_entries (organization_id, source_id, account, direction, asset_symbol)
  WHERE ledger_event_type IN ('LIQUIDITY_SETTLED', 'LIQUIDITY_SWAP_SETTLED');

INSERT INTO opes.schema_migrations (version)
VALUES ('0019_liquidity_settlement')
ON CONFLICT (version) DO NOTHING;

COMMIT;
