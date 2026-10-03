BEGIN;

CREATE TABLE IF NOT EXISTS opes.payment_decision_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  decision_version integer NOT NULL,
  source_version_id uuid NOT NULL,
  amount_atomic bigint NOT NULL,
  destination_address text NOT NULL,
  context_hash text NOT NULL,
  policy_snapshot_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  approved_by_membership_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT payment_decision_approvals_status_check CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT payment_decision_approvals_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT payment_decision_approvals_hash_check CHECK (
    context_hash ~ '^[0-9a-f]{64}$'
      AND policy_snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, decision_id, status),
  FOREIGN KEY (organization_id, decision_id)
    REFERENCES opes.payment_decisions (organization_id, id),
  FOREIGN KEY (organization_id, approved_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.payment_decision_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.payment_decision_approvals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'opes'
      AND tablename = 'payment_decision_approvals'
      AND policyname = 'payment_decision_approvals_tenant_isolation'
  ) THEN
    CREATE POLICY payment_decision_approvals_tenant_isolation
      ON opes.payment_decision_approvals
      USING (organization_id = opes.current_organization_id())
      WITH CHECK (organization_id = opes.current_organization_id());
  END IF;
END $$;

INSERT INTO opes.schema_migrations (version)
VALUES ('0012_payment_decision_approvals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
