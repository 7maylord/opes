BEGIN;

CREATE TABLE IF NOT EXISTS opes.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  vendor_address_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status_check CHECK (
    status IN ('ACTIVE', 'PAUSED', 'CANCELLED')
  ),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, vendor_address_id)
    REFERENCES opes.vendor_payout_addresses (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.subscription_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  version integer NOT NULL,
  cadence text NOT NULL,
  timezone text NOT NULL,
  anchor_date date NOT NULL,
  amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL DEFAULT 6,
  currency text NOT NULL DEFAULT 'USDC',
  status text NOT NULL DEFAULT 'ACTIVE',
  terms_document_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_versions_cadence_check CHECK (
    cadence IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL')
  ),
  CONSTRAINT subscription_versions_status_check CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  CONSTRAINT subscription_versions_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT subscription_versions_decimals_check CHECK (amount_decimals = 6),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, subscription_id, version),
  FOREIGN KEY (organization_id, subscription_id)
    REFERENCES opes.subscriptions (organization_id, id),
  FOREIGN KEY (organization_id, terms_document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.subscription_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  subscription_version_id uuid NOT NULL,
  service_period_start date NOT NULL,
  service_period_end date NOT NULL,
  due_at timestamptz NOT NULL,
  amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL DEFAULT 6,
  currency text NOT NULL DEFAULT 'USDC',
  status text NOT NULL DEFAULT 'DUE',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_cycles_period_check CHECK (service_period_end > service_period_start),
  CONSTRAINT subscription_cycles_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT subscription_cycles_decimals_check CHECK (amount_decimals = 6),
  CONSTRAINT subscription_cycles_status_check CHECK (
    status IN ('DUE', 'BLOCKED', 'CANCELLED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, subscription_id, service_period_start, service_period_end),
  FOREIGN KEY (organization_id, subscription_id)
    REFERENCES opes.subscriptions (organization_id, id),
  FOREIGN KEY (organization_id, subscription_version_id)
    REFERENCES opes.subscription_versions (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.escrow_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  vendor_address_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  total_amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL DEFAULT 6,
  currency text NOT NULL DEFAULT 'USDC',
  agreement_document_id uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_agreements_status_check CHECK (
    status IN ('ACTIVE', 'DISPUTED', 'CANCELLED', 'COMPLETED')
  ),
  CONSTRAINT escrow_agreements_total_check CHECK (total_amount_atomic > 0),
  CONSTRAINT escrow_agreements_decimals_check CHECK (amount_decimals = 6),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, vendor_id)
    REFERENCES opes.vendors (organization_id, id),
  FOREIGN KEY (organization_id, vendor_address_id)
    REFERENCES opes.vendor_payout_addresses (organization_id, id),
  FOREIGN KEY (organization_id, agreement_document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

CREATE TABLE IF NOT EXISTS opes.escrow_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  milestone_index integer NOT NULL,
  title text NOT NULL,
  amount_atomic bigint NOT NULL,
  amount_decimals smallint NOT NULL DEFAULT 6,
  status text NOT NULL DEFAULT 'PENDING',
  evidence_document_id uuid,
  accepted_by_membership_id uuid,
  accepted_at timestamptz,
  dispute_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_milestones_index_check CHECK (milestone_index >= 0 AND milestone_index < 5),
  CONSTRAINT escrow_milestones_amount_check CHECK (amount_atomic > 0),
  CONSTRAINT escrow_milestones_decimals_check CHECK (amount_decimals = 6),
  CONSTRAINT escrow_milestones_status_check CHECK (
    status IN ('PENDING', 'SUBMITTED', 'ACCEPTED', 'DISPUTED', 'RELEASED', 'REFUNDED')
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, agreement_id, milestone_index),
  FOREIGN KEY (organization_id, agreement_id)
    REFERENCES opes.escrow_agreements (organization_id, id),
  FOREIGN KEY (organization_id, evidence_document_id)
    REFERENCES opes.evidence_documents (organization_id, id),
  FOREIGN KEY (organization_id, accepted_by_membership_id)
    REFERENCES opes.organization_memberships (organization_id, id)
);

ALTER TABLE opes.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.subscription_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.subscription_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.subscription_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.subscription_cycles FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.escrow_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.escrow_agreements FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.escrow_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.escrow_milestones FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'subscriptions',
    'subscription_versions',
    'subscription_cycles',
    'escrow_agreements',
    'escrow_milestones'
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
VALUES ('0010_subscription_milestone_lifecycles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
