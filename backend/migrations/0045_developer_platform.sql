BEGIN;
CREATE TABLE opes.api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, name text NOT NULL,
  key_hash text NOT NULL, key_prefix text NOT NULL, scopes jsonb NOT NULL, status text NOT NULL DEFAULT 'ACTIVE',
  created_by_membership_id uuid NOT NULL, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(organization_id,id), UNIQUE(key_hash), CHECK(jsonb_typeof(scopes)='array'), CHECK(status IN('ACTIVE','REVOKED')),
  FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES opes.organization_memberships(organization_id,id)
);
CREATE TABLE opes.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, url text NOT NULL,
  description text NOT NULL, signing_secret_encrypted text NOT NULL, event_types jsonb NOT NULL, status text NOT NULL DEFAULT 'ACTIVE',
  created_by_membership_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz,
  UNIQUE(organization_id,id), CHECK(jsonb_typeof(event_types)='array'), CHECK(status IN('ACTIVE','DISABLED')),
  FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES opes.organization_memberships(organization_id,id)
);
CREATE TABLE opes.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(), event_key text NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer, response_body text, last_error text, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id), UNIQUE(endpoint_id,event_key), UNIQUE(event_id), CHECK(status IN('PENDING','PROCESSING','DELIVERED','FAILED')), CHECK(attempt_count BETWEEN 0 AND 5),
  FOREIGN KEY(organization_id,endpoint_id) REFERENCES opes.webhook_endpoints(organization_id,id)
);
CREATE INDEX webhook_deliveries_due_idx ON opes.webhook_deliveries(status,next_attempt_at,created_at);
ALTER TABLE opes.api_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.api_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.webhook_endpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.webhook_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.webhook_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE opes.webhook_deliveries FORCE ROW LEVEL SECURITY;
DO $$ DECLARE table_name text; BEGIN FOREACH table_name IN ARRAY ARRAY['api_credentials','webhook_endpoints','webhook_deliveries'] LOOP
  EXECUTE format('CREATE POLICY %I_tenant_isolation ON opes.%I USING (organization_id=opes.current_organization_id()) WITH CHECK (organization_id=opes.current_organization_id())',table_name,table_name);
  EXECUTE format('CREATE POLICY %I_worker_access ON opes.%I USING (current_setting(''opes.worker'',true)=''true'') WITH CHECK (current_setting(''opes.worker'',true)=''true'')',table_name,table_name);
END LOOP; END $$;
INSERT INTO opes.schema_migrations(version) VALUES('0045_developer_platform') ON CONFLICT DO NOTHING;
COMMIT;
