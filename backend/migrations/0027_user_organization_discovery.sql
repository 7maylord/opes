BEGIN;

CREATE OR REPLACE FUNCTION opes.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('opes.user_id', true), '')::uuid
$$;

CREATE POLICY organization_memberships_user_discovery
  ON opes.organization_memberships
  FOR SELECT
  USING (user_id = opes.current_user_id());

CREATE POLICY organizations_user_discovery
  ON opes.organizations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM opes.organization_memberships AS membership
      WHERE membership.organization_id = organizations.id
        AND membership.user_id = opes.current_user_id()
        AND membership.status = 'ACTIVE'
    )
  );

CREATE POLICY business_agents_user_discovery
  ON opes.business_agents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM opes.organization_memberships AS membership
      WHERE membership.organization_id = business_agents.organization_id
        AND membership.user_id = opes.current_user_id()
        AND membership.status = 'ACTIVE'
    )
  );

INSERT INTO opes.schema_migrations (version)
VALUES ('0027_user_organization_discovery')
ON CONFLICT (version) DO NOTHING;

COMMIT;
