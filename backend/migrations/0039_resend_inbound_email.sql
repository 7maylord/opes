BEGIN;

CREATE TABLE opes.email_inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations(id),
  address text NOT NULL,
  address_normalized text GENERATED ALWAYS AS (lower(address)) STORED,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('ACTIVE','DISABLED')),
  CHECK (address = lower(address)),
  CHECK (address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  UNIQUE (organization_id),
  UNIQUE (organization_id,id),
  UNIQUE (address_normalized),
  FOREIGN KEY (organization_id,created_by_membership_id)
    REFERENCES opes.organization_memberships(organization_id,id)
);

CREATE TABLE opes.inbound_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES opes.organizations(id),
  inbox_id uuid,
  provider text NOT NULL DEFAULT 'resend',
  provider_event_id text NOT NULL,
  provider_email_id text NOT NULL,
  payload_hash text NOT NULL,
  recipient_address text,
  sender_address text,
  sender_domain text,
  status text NOT NULL DEFAULT 'RECEIVED',
  quarantine_reason text,
  failure_reason text,
  document_count integer NOT NULL DEFAULT 0,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider='resend'),
  CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','QUARANTINED','FAILED')),
  CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CHECK (document_count >= 0),
  UNIQUE (provider,provider_event_id),
  UNIQUE (provider,provider_email_id),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,inbox_id)
    REFERENCES opes.email_inboxes(organization_id,id)
);

CREATE INDEX inbound_email_events_status_received_idx
  ON opes.inbound_email_events(status,received_at);

ALTER TABLE opes.email_inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.email_inboxes FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.inbound_email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.inbound_email_events FORCE ROW LEVEL SECURITY;

CREATE POLICY email_inboxes_tenant_isolation ON opes.email_inboxes
  USING (organization_id=opes.current_organization_id())
  WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY email_inboxes_worker_access ON opes.email_inboxes
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');
CREATE POLICY inbound_email_events_tenant_isolation ON opes.inbound_email_events
  USING (organization_id=opes.current_organization_id())
  WITH CHECK (organization_id=opes.current_organization_id());
CREATE POLICY inbound_email_events_worker_access ON opes.inbound_email_events
  USING (current_setting('opes.worker',true)='true')
  WITH CHECK (current_setting('opes.worker',true)='true');

INSERT INTO opes.schema_migrations(version)
VALUES ('0039_resend_inbound_email') ON CONFLICT DO NOTHING;

COMMIT;
