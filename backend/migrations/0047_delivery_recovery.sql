BEGIN;
ALTER TABLE opes.webhook_deliveries ADD COLUMN claim_token uuid;
ALTER TABLE opes.outbox_events ADD COLUMN claim_token uuid;
ALTER TABLE opes.outbound_email_deliveries ADD COLUMN first_attempt_at timestamptz,
  ADD COLUMN request_payload jsonb;
UPDATE opes.outbound_email_deliveries SET first_attempt_at=LEAST(created_at,now()-interval '24 hours') WHERE attempts>0;
INSERT INTO opes.schema_migrations(version) VALUES('0047_delivery_recovery');
COMMIT;
