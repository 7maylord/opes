BEGIN;

CREATE TABLE IF NOT EXISTS opes.global_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_idempotency_records_status_check CHECK (
    status IN ('PROCESSING', 'COMPLETED')
  ),
  UNIQUE (route, idempotency_key)
);

INSERT INTO opes.schema_migrations (version)
VALUES ('0005_global_idempotency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
