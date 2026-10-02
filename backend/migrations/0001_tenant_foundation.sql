BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS opes;

CREATE OR REPLACE FUNCTION opes.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('opes.organization_id', true), '')::uuid
$$;

CREATE TABLE IF NOT EXISTS opes.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opes.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text GENERATED ALWAYS AS (lower(email)) STORED,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_users_status_check CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_normalized_key
  ON opes.app_users (email_normalized);

CREATE TABLE IF NOT EXISTS opes.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  lifecycle_status text NOT NULL DEFAULT 'PROVISIONING',
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_lifecycle_status_check CHECK (
    lifecycle_status IN (
      'PROVISIONING',
      'SETUP_REQUIRED',
      'ACTIVE',
      'PAUSED',
      'SUSPENDED',
      'PROVISIONING_FAILED',
      'DECOMMISSIONED'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key
  ON opes.organizations (slug);

CREATE TABLE IF NOT EXISTS opes.organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  user_id uuid NOT NULL REFERENCES opes.app_users (id),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  invited_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_memberships_role_check CHECK (
    role IN ('OWNER', 'ADMIN', 'APPROVER', 'OPERATOR_VIEWER', 'AUDITOR')
  ),
  CONSTRAINT organization_memberships_status_check CHECK (
    status IN ('ACTIVE', 'REVOKED', 'INVITED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_memberships_inviter_tenant_fk'
  ) THEN
    ALTER TABLE opes.organization_memberships
      ADD CONSTRAINT organization_memberships_inviter_tenant_fk
      FOREIGN KEY (organization_id, invited_by_membership_id)
      REFERENCES opes.organization_memberships (organization_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS opes.business_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  is_primary boolean NOT NULL DEFAULT true,
  lifecycle_status text NOT NULL DEFAULT 'PROVISIONING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_agents_lifecycle_status_check CHECK (
    lifecycle_status IN (
      'PROVISIONING',
      'SETUP_REQUIRED',
      'ACTIVE',
      'PAUSED',
      'SUSPENDED',
      'PROVISIONING_FAILED',
      'DECOMMISSIONED'
    )
  ),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS business_agents_one_primary_per_organization
  ON opes.business_agents (organization_id)
  WHERE is_primary;

CREATE TABLE IF NOT EXISTS opes.tenant_resource_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  environment text NOT NULL,
  chain_id integer,
  provider text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  address text,
  status text NOT NULL DEFAULT 'PENDING',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_resource_bindings_status_check CHECK (
    status IN ('PENDING', 'ACTIVE', 'DISABLED', 'FAILED')
  ),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_resource_bindings_global_resource_key
  ON opes.tenant_resource_bindings (
    provider,
    environment,
    resource_type,
    resource_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS tenant_resource_bindings_global_address_key
  ON opes.tenant_resource_bindings (
    provider,
    environment,
    chain_id,
    lower(address)
  )
  WHERE address IS NOT NULL;

CREATE TABLE IF NOT EXISTS opes.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  actor_user_id uuid REFERENCES opes.app_users (id),
  actor_membership_id uuid,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, actor_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT outbox_events_status_check CHECK (
    status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')
  ),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
  ON opes.outbox_events (status, available_at, created_at);

ALTER TABLE opes.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.organization_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.business_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.business_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.tenant_resource_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.tenant_resource_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.outbox_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'organizations'
      AND policyname = 'organizations_tenant_isolation'
  ) THEN
    CREATE POLICY organizations_tenant_isolation
      ON opes.organizations
      USING (id = opes.current_organization_id())
      WITH CHECK (id = opes.current_organization_id());
  END IF;
END $$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships',
    'business_agents',
    'tenant_resource_bindings',
    'audit_events',
    'outbox_events'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'opes'
        AND tablename = table_name
        AND policyname = table_name || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON opes.%I USING (organization_id = opes.current_organization_id()) WITH CHECK (organization_id = opes.current_organization_id())',
        table_name || '_tenant_isolation',
        table_name
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0001_tenant_foundation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
