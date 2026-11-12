BEGIN;

ALTER TABLE opes.ledger_entries DROP CONSTRAINT ledger_entries_event_type_check;
ALTER TABLE opes.ledger_entries ADD CONSTRAINT ledger_entries_event_type_check CHECK (ledger_event_type IN (
  'INVOICE_ACCEPTED','PAYMENT_SETTLED','RECURRING_PAYMENT_SETTLED','LIQUIDITY_SETTLED','LIQUIDITY_SWAP_SETTLED',
  'LIQUIDITY_FEE','ESCROW_FUNDED','ESCROW_MILESTONE_RELEASED','ESCROW_REFUNDED','USDC_RECOVERED','SPONSOR_GAS_SPENT',
  'CREDIT_NOTE_POSTED','REFUND_POSTED'
));

CREATE TABLE opes.payment_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, correction_type text NOT NULL,
  original_execution_id uuid NOT NULL, credit_note_id uuid, amount_atomic bigint NOT NULL, reason text NOT NULL,
  transaction_hash text, status text NOT NULL DEFAULT 'POSTED', created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,transaction_hash),
  CHECK(correction_type IN ('CREDIT_NOTE','REFUND')), CHECK(status='POSTED'), CHECK(amount_atomic>0),
  CHECK(length(reason) BETWEEN 3 AND 500),
  CHECK((correction_type='CREDIT_NOTE' AND credit_note_id IS NULL AND transaction_hash IS NULL) OR
        (correction_type='REFUND' AND credit_note_id IS NOT NULL AND transaction_hash ~ '^0x[0-9a-fA-F]{64}$')),
  FOREIGN KEY(organization_id,original_execution_id) REFERENCES opes.payment_executions(organization_id,id),
  FOREIGN KEY(organization_id,credit_note_id) REFERENCES opes.payment_corrections(organization_id,id),
  FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES opes.organization_memberships(organization_id,id)
);
ALTER TABLE opes.payment_corrections ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.payment_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_corrections_tenant_isolation ON opes.payment_corrections USING (organization_id=opes.current_organization_id()) WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY payment_corrections_worker_access ON opes.payment_corrections USING (current_setting('opes.worker',true)='true') WITH CHECK (current_setting('opes.worker',true)='true');
CREATE FUNCTION opes.prevent_payment_correction_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment corrections are immutable'; END $$;
CREATE TRIGGER payment_corrections_immutable BEFORE UPDATE OR DELETE ON opes.payment_corrections FOR EACH ROW EXECUTE FUNCTION opes.prevent_payment_correction_changes();

INSERT INTO opes.schema_migrations(version) VALUES('0044_payment_corrections') ON CONFLICT DO NOTHING;
COMMIT;
