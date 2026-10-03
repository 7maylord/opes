BEGIN;

CREATE TABLE IF NOT EXISTS opes.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ledger_event_type text NOT NULL,
  ledger_event_id uuid NOT NULL,
  line_number smallint NOT NULL,
  account text NOT NULL,
  direction text NOT NULL,
  asset_symbol text NOT NULL,
  amount_atomic bigint NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_version_id uuid,
  counterparty_id uuid,
  transaction_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_event_type_check CHECK (
    ledger_event_type IN ('INVOICE_ACCEPTED', 'PAYMENT_SETTLED')
  ),
  CONSTRAINT ledger_entries_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_entries_asset_check CHECK (asset_symbol IN ('USDC')),
  CONSTRAINT ledger_entries_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT ledger_entries_transaction_hash_check CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, ledger_event_type, ledger_event_id, line_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_invoice_accrual_once
  ON opes.ledger_entries (organization_id, source_id, account, direction)
  WHERE ledger_event_type = 'INVOICE_ACCEPTED';

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_payment_settlement_once
  ON opes.ledger_entries (organization_id, source_id, account, direction)
  WHERE ledger_event_type = 'PAYMENT_SETTLED';

ALTER TABLE opes.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.ledger_entries FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'ledger_entries'
      AND policyname = 'ledger_entries_tenant_isolation'
  ) THEN
    CREATE POLICY ledger_entries_tenant_isolation
      ON opes.ledger_entries
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0015_ledger_entries')
ON CONFLICT (version) DO NOTHING;

COMMIT;
