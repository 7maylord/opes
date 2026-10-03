BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'business_agents'
      AND policyname = 'business_agents_worker_access'
  ) THEN
    CREATE POLICY business_agents_worker_access
      ON opes.business_agents
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0007_worker_agent_access')
ON CONFLICT (version) DO NOTHING;

COMMIT;
