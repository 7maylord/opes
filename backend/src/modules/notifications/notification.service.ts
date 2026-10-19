import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import { enqueueWebhookEvent } from '../developers/developer-platform.service';

export interface WorkspaceNotification {
  id: string;
  type: string;
  priority: 'INFO' | 'ACTION' | 'WARNING' | 'SUCCESS';
  title: string;
  body: string;
  subjectType: string;
  subjectId: string | null;
  actionView: string | null;
  metadata: unknown;
  readAt: string | null;
  createdAt: string;
}

interface NotificationRow {
  id: string;
  notification_type: string;
  priority: WorkspaceNotification['priority'];
  title: string;
  body: string;
  subject_type: string;
  subject_id: string | null;
  action_view: string | null;
  metadata: unknown;
  read_at: Date | null;
  created_at: Date;
}

export interface NotificationInput {
  organizationId: string;
  type: string;
  priority: WorkspaceNotification['priority'];
  title: string;
  body: string;
  subjectType: string;
  subjectId?: string | null;
  actionView?: string | null;
  dedupeKey: string;
  metadata?: unknown;
}

@Injectable()
export class NotificationService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    context: TenantContext,
    limit = 50,
  ): Promise<WorkspaceNotification[]> {
    const boundedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), 100)
      : 50;
    const result = await this.database.withTenant(context, (database) =>
      database.query<NotificationRow>(
        `SELECT notification.id,notification.notification_type,notification.priority,
                notification.title,notification.body,notification.subject_type,
                notification.subject_id,notification.action_view,notification.metadata,
                receipt.read_at,notification.created_at
           FROM opes.workspace_notifications notification
           LEFT JOIN opes.workspace_notification_reads receipt
             ON receipt.organization_id=notification.organization_id
            AND receipt.notification_id=notification.id
            AND receipt.membership_id=$2
          WHERE notification.organization_id=$1
          ORDER BY notification.created_at DESC LIMIT $3`,
        [context.organizationId, context.membershipId, boundedLimit],
      ),
    );
    return result.rows.map(mapNotification);
  }

  async unreadCount(context: TenantContext): Promise<{ unread: number }> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<{ unread: number }>(
        `SELECT count(*)::integer AS unread
           FROM opes.workspace_notifications notification
          WHERE notification.organization_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM opes.workspace_notification_reads receipt
               WHERE receipt.organization_id=notification.organization_id
                 AND receipt.notification_id=notification.id
                 AND receipt.membership_id=$2
            )`,
        [context.organizationId, context.membershipId],
      ),
    );
    return { unread: result.rows[0]?.unread ?? 0 };
  }

  async markRead(
    context: TenantContext,
    notificationId: string,
  ): Promise<{ read: true }> {
    requireUuid(notificationId);
    await this.database.withTenant(context, (database) =>
      database.query(
        `INSERT INTO opes.workspace_notification_reads
          (organization_id,notification_id,membership_id)
         SELECT $1,notification.id,$3
           FROM opes.workspace_notifications notification
          WHERE notification.organization_id=$1 AND notification.id=$2
         ON CONFLICT (organization_id,notification_id,membership_id)
         DO UPDATE SET read_at=EXCLUDED.read_at`,
        [context.organizationId, notificationId, context.membershipId],
      ),
    );
    return { read: true };
  }

  async markAllRead(context: TenantContext): Promise<{ read: true }> {
    await this.database.withTenant(context, (database) =>
      database.query(
        `INSERT INTO opes.workspace_notification_reads
          (organization_id,notification_id,membership_id)
         SELECT notification.organization_id,notification.id,$2
           FROM opes.workspace_notifications notification
          WHERE notification.organization_id=$1
         ON CONFLICT (organization_id,notification_id,membership_id)
         DO UPDATE SET read_at=EXCLUDED.read_at`,
        [context.organizationId, context.membershipId],
      ),
    );
    return { read: true };
  }
}

export async function recordNotification(
  database: TenantDatabase,
  input: NotificationInput,
): Promise<void> {
  await database.query(
    `INSERT INTO opes.workspace_notifications
      (organization_id,notification_type,priority,title,body,subject_type,subject_id,action_view,dedupe_key,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (organization_id,dedupe_key) DO NOTHING`,
    [
      input.organizationId,
      input.type,
      input.priority,
      input.title,
      input.body,
      input.subjectType,
      input.subjectId ?? null,
      input.actionView ?? null,
      input.dedupeKey,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await enqueueWebhookEvent(
    database,
    input.organizationId,
    input.type,
    `notification:${input.dedupeKey}`,
    {
      title: input.title,
      body: input.body,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      metadata: input.metadata ?? {},
    },
  );
}

export async function recordPaymentSettlementCommunications(
  database: TenantDatabase,
  organizationId: string,
  executionId: string,
): Promise<void> {
  const result = await database.query<{
    invoice_number: string;
    amount_atomic: string;
    asset_symbol: string;
    vendor_name: string;
    recipient_email: string | null;
    transaction_hash: string;
  }>(
    `SELECT version.invoice_number,execution.amount_atomic::text AS amount_atomic,
            execution.route_asset_symbol AS asset_symbol,vendor.display_name AS vendor_name,
            contact.contact_email AS recipient_email,execution.transaction_hash
       FROM opes.payment_executions execution
       JOIN opes.payable_obligation_versions version
         ON version.organization_id=execution.organization_id AND version.id=execution.source_version_id
       JOIN opes.vendors vendor
         ON vendor.organization_id=version.organization_id AND vendor.id=version.vendor_id
       LEFT JOIN LATERAL (
         SELECT access.contact_email FROM opes.vendor_portal_accesses access
          WHERE access.organization_id=vendor.organization_id AND access.vendor_id=vendor.id
          ORDER BY access.created_at DESC LIMIT 1
       ) contact ON true
      WHERE execution.organization_id=$1 AND execution.id=$2 AND execution.status='CONFIRMED'`,
    [organizationId, executionId],
  );
  const row = result.rows[0];
  if (!row) return;
  await recordNotification(database, {
    organizationId,
    type: 'PAYMENT_SETTLED',
    priority: 'SUCCESS',
    title: `Invoice ${row.invoice_number} settled`,
    body: `${formatAtomic(row.amount_atomic)} ${row.asset_symbol} was paid to ${row.vendor_name}.`,
    subjectType: 'payment_execution',
    subjectId: executionId,
    actionView: 'treasury',
    dedupeKey: `payment-settled:${executionId}`,
    metadata: { transactionHash: row.transaction_hash },
  });
  if (!row.recipient_email) return;
  const delivery = await database.query<{ id: string }>(
    `INSERT INTO opes.outbound_email_deliveries
      (organization_id,delivery_type,aggregate_id,recipient_email)
     VALUES ($1,'PAYMENT_ADVICE',$2,$3)
     ON CONFLICT (organization_id,delivery_type,aggregate_id)
     DO UPDATE SET recipient_email=EXCLUDED.recipient_email,updated_at=now()
     RETURNING id`,
    [organizationId, executionId, row.recipient_email],
  );
  const deliveryId = delivery.rows[0]?.id;
  if (!deliveryId) return;
  await database.query(
    `INSERT INTO opes.outbox_events
      (organization_id,event_type,aggregate_type,aggregate_id,payload)
     SELECT $1,'PAYMENT_ADVICE_EMAIL','outbound_email_delivery',$2,'{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM opes.outbox_events
         WHERE organization_id=$1 AND event_type='PAYMENT_ADVICE_EMAIL' AND aggregate_id=$2
      )`,
    [organizationId, deliveryId],
  );
}

function mapNotification(row: NotificationRow): WorkspaceNotification {
  return {
    id: row.id,
    type: row.notification_type,
    priority: row.priority,
    title: row.title,
    body: row.body,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    actionView: row.action_view,
    metadata: row.metadata,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
function formatAtomic(value: string) {
  const padded = value.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function requireUuid(value: string) {
  if (!/^[0-9a-fA-F-]{36}$/.test(value))
    throw new BadRequestException('notificationId must be a UUID');
}
