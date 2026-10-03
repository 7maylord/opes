BEGIN;

CREATE TABLE IF NOT EXISTS opes.organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  membership_id uuid NOT NULL,
  invited_by_membership_id uuid NOT NULL,
  token_hash text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_invitations_role_check CHECK (
    role IN ('ADMIN', 'APPROVER', 'OPERATOR_VIEWER', 'AUDITOR')
  ),
  CONSTRAINT organization_invitations_status_check CHECK (
    status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')
  ),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id)
    REFERENCES opes.organization_memberships (organization_id, id),
  FOREIGN KEY (organization_id, invited_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_token_hash_key
  ON opes.organization_invitations (token_hash);

CREATE INDEX IF NOT EXISTS organization_invitations_membership_pending_idx
  ON opes.organization_invitations (organization_id, membership_id, status)
  WHERE status = 'PENDING';

INSERT INTO opes.schema_migrations (version)
VALUES ('0003_organization_invitations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
