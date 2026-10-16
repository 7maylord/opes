BEGIN;

CREATE TABLE IF NOT EXISTS opes.workspace_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  notification_type text NOT NULL,
  priority text NOT NULL DEFAULT 'INFO',
  title text NOT NULL,
  body text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  action_view text,
  dedupe_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_notifications_priority_check CHECK (priority IN ('INFO','ACTION','WARNING','SUCCESS')),
  CONSTRAINT workspace_notifications_action_view_check CHECK (action_view IS NULL OR action_view IN ('overview','setup','invoices','agreements','treasury','inbox','integrations','team','notifications')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS opes.workspace_notification_reads (
  organization_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, notification_id, membership_id),
  FOREIGN KEY (organization_id, notification_id) REFERENCES opes.workspace_notifications (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, membership_id) REFERENCES opes.organization_memberships (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opes.outbound_email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES opes.organizations (id),
  delivery_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  recipient_email text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  provider_message_id text,
  failure_reason text,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_email_deliveries_type_check CHECK (delivery_type IN ('PAYMENT_ADVICE')),
  CONSTRAINT outbound_email_deliveries_status_check CHECK (status IN ('PENDING','SENDING','SENT','FAILED')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, delivery_type, aggregate_id)
);

CREATE INDEX IF NOT EXISTS workspace_notifications_recent_idx ON opes.workspace_notifications (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outbound_email_deliveries_status_idx ON opes.outbound_email_deliveries (status, created_at);

ALTER TABLE opes.workspace_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.workspace_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.workspace_notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.workspace_notification_reads FORCE ROW LEVEL SECURITY;
ALTER TABLE opes.outbound_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE opes.outbound_email_deliveries FORCE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_notifications','workspace_notification_reads','outbound_email_deliveries'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='opes' AND tablename=table_name AND policyname=table_name || '_tenant_isolation') THEN
      EXECUTE format('CREATE POLICY %I ON opes.%I USING (organization_id = opes.current_organization_id()) WITH CHECK (organization_id = opes.current_organization_id())', table_name || '_tenant_isolation', table_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_notifications','workspace_notification_reads','outbound_email_deliveries'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='opes' AND tablename=table_name AND policyname=table_name || '_worker_access') THEN
      EXECUTE format('CREATE POLICY %I ON opes.%I USING (current_setting(''opes.worker'', true) = ''true'') WITH CHECK (current_setting(''opes.worker'', true) = ''true'')', table_name || '_worker_access', table_name);
    END IF;
  END LOOP;
END $$;

INSERT INTO opes.schema_migrations (version) VALUES ('0042_notifications_and_payment_advice') ON CONFLICT DO NOTHING;

COMMIT;
