BEGIN;

CREATE TABLE IF NOT EXISTS opes.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES opes.app_users (id),
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT user_sessions_status_check CHECK (
    status IN ('ACTIVE', 'REVOKED', 'EXPIRED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_key
  ON opes.user_sessions (token_hash);

CREATE INDEX IF NOT EXISTS user_sessions_active_user_idx
  ON opes.user_sessions (user_id, status, expires_at);

INSERT INTO opes.schema_migrations (version)
VALUES ('0002_user_sessions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
