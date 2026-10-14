BEGIN;

ALTER TABLE opes.external_accounting_records
  ADD COLUMN intake_envelope_id uuid;

ALTER TABLE opes.external_accounting_records
  ADD CONSTRAINT external_accounting_records_intake_fk
  FOREIGN KEY (organization_id, intake_envelope_id)
  REFERENCES opes.intake_envelopes (organization_id, id);

ALTER TABLE opes.external_accounting_records
  ALTER COLUMN intake_envelope_id SET NOT NULL;

INSERT INTO opes.schema_migrations (version)
VALUES ('0033_accounting_intake_link')
ON CONFLICT (version) DO NOTHING;

COMMIT;
