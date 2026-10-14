BEGIN;

CREATE UNIQUE INDEX accounting_writeback_pending_idx
  ON opes.outbox_events (organization_id, aggregate_id)
  WHERE event_type = 'accounting.settlement.writeback'
    AND status IN ('PENDING', 'PROCESSING');

INSERT INTO opes.schema_migrations (version)
VALUES ('0034_accounting_writeback_idempotency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
