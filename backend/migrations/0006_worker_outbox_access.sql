BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'outbox_events'
      AND policyname = 'outbox_events_worker_access'
  ) THEN
    CREATE POLICY outbox_events_worker_access
      ON opes.outbox_events
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'tenant_resource_bindings'
      AND policyname = 'tenant_resource_bindings_worker_access'
  ) THEN
    CREATE POLICY tenant_resource_bindings_worker_access
      ON opes.tenant_resource_bindings
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0006_worker_outbox_access')
ON CONFLICT (version) DO NOTHING;

COMMIT;
