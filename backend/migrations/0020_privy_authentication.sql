DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'opes'
       AND table_name = 'app_users'
       AND column_name = 'privy_user_id'
  ) THEN
    ALTER TABLE opes.app_users ADD COLUMN privy_user_id text;
    UPDATE opes.user_sessions SET status = 'REVOKED' WHERE status = 'ACTIVE';
  END IF;
END
$$;

ALTER TABLE opes.app_users
  ADD COLUMN IF NOT EXISTS privy_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_privy_user_id_key
  ON opes.app_users (privy_user_id)
  WHERE privy_user_id IS NOT NULL;
