BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'opes' AND table_name = 'app_users'
       AND column_name = 'owner_wallet_address'
  ) THEN
    ALTER TABLE opes.app_users ADD COLUMN owner_wallet_address text;
    UPDATE opes.user_sessions SET status = 'REVOKED' WHERE status = 'ACTIVE';
  END IF;
END
$$;

ALTER TABLE opes.app_users
  ADD COLUMN IF NOT EXISTS owner_wallet_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_owner_wallet_address_key
  ON opes.app_users (lower(owner_wallet_address))
  WHERE owner_wallet_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS opes.provider_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL,
  resource_type text NOT NULL,
  resource_key text NOT NULL,
  provider_resource_id text,
  address text,
  status text NOT NULL DEFAULT 'PENDING',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_resources_status_check CHECK (
    status IN ('PENDING', 'ACTIVE', 'FAILED')
  ),
  UNIQUE (provider, environment, resource_type, resource_key)
);

ALTER TABLE opes.provider_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.provider_resources FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'opes' AND tablename = 'provider_resources'
       AND policyname = 'provider_resources_worker_access'
  ) THEN
    CREATE POLICY provider_resources_worker_access
      ON opes.provider_resources
      USING (current_setting('opes.worker', true) = 'true')
      WITH CHECK (current_setting('opes.worker', true) = 'true');
  END IF;
END
$$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0021_owner_wallets_and_circle_resources')
ON CONFLICT (version) DO NOTHING;

COMMIT;
