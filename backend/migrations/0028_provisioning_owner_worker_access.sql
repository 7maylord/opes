BEGIN;

CREATE POLICY organization_memberships_worker_read
  ON opes.organization_memberships
  FOR SELECT
  USING (current_setting('opes.worker', true) = 'true');

INSERT INTO opes.schema_migrations (version)
VALUES ('0028_provisioning_owner_worker_access')
ON CONFLICT (version) DO NOTHING;

COMMIT;
