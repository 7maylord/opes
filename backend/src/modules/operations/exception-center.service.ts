import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

export type ExceptionCategory =
  | 'PAYMENT'
  | 'LIQUIDITY'
  | 'AGREEMENT'
  | 'TREASURY'
  | 'INTEGRATION'
  | 'INBOX'
  | 'PROVISIONING'
  | 'SYSTEM';

export interface OperationalException {
  id: string;
  category: ExceptionCategory;
  severity: 'WARNING' | 'CRITICAL';
  status: string;
  title: string;
  reason: string;
  recommendation: string;
  recoveryMode: 'USER_ACTION' | 'AUTO_RECOVERING' | 'PLATFORM_ACTION';
  actionView: string;
  actionLabel: string;
  subjectType: string;
  subjectId: string;
  relatedRecordId: string | null;
  updatedAt: string;
}

export interface ExceptionCenterResponse {
  items: OperationalException[];
  summary: {
    total: number;
    critical: number;
    userAction: number;
    autoRecovering: number;
  };
}

interface ExceptionRow {
  id: string;
  category: ExceptionCategory;
  severity: OperationalException['severity'];
  status: string;
  title: string;
  reason: string;
  recommendation: string;
  recovery_mode: OperationalException['recoveryMode'];
  action_view: string;
  action_label: string;
  subject_type: string;
  subject_id: string;
  related_record_id: string | null;
  updated_at: Date;
}

@Injectable()
export class ExceptionCenterService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext): Promise<ExceptionCenterResponse> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<ExceptionRow>(exceptionsSql(), [context.organizationId]),
    );
    const items = result.rows.map(mapException);
    return {
      items,
      summary: {
        total: items.length,
        critical: items.filter((item) => item.severity === 'CRITICAL').length,
        userAction: items.filter((item) => item.recoveryMode === 'USER_ACTION')
          .length,
        autoRecovering: items.filter(
          (item) => item.recoveryMode === 'AUTO_RECOVERING',
        ).length,
      },
    };
  }
}

function mapException(row: ExceptionRow): OperationalException {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    reason: row.reason,
    recommendation: row.recommendation,
    recoveryMode: row.recovery_mode,
    actionView: row.action_view,
    actionLabel: row.action_label,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    relatedRecordId: row.related_record_id,
    updatedAt: row.updated_at.toISOString(),
  };
}

function exceptionsSql(): string {
  return `
    WITH exceptions AS (
      SELECT execution.id, 'PAYMENT'::text AS category,
             CASE WHEN execution.status='UNKNOWN' THEN 'CRITICAL' ELSE 'WARNING' END AS severity,
             execution.status, 'Payment execution needs attention'::text AS title,
             COALESCE(execution.failure_reason,'The payment did not complete.') AS reason,
             CASE WHEN execution.status='UNKNOWN'
               THEN 'OPES is reconciling the submitted transaction. Do not submit another payment.'
               ELSE 'Review the invoice, correct the cause, and create a fresh payment decision.' END AS recommendation,
             CASE WHEN execution.status='UNKNOWN' THEN 'AUTO_RECOVERING' ELSE 'USER_ACTION' END AS recovery_mode,
             'invoices'::text AS action_view, 'Open invoice'::text AS action_label,
             'payment_execution'::text AS subject_type, execution.id AS subject_id,
             execution.source_version_id AS related_record_id, execution.updated_at
        FROM opes.payment_executions execution
       WHERE execution.organization_id=$1 AND execution.status IN ('FAILED','UNKNOWN')
      UNION ALL
      SELECT action.id, 'LIQUIDITY',
             CASE WHEN action.status='UNKNOWN' THEN 'CRITICAL' ELSE 'WARNING' END,
             action.status, 'Crosschain liquidity needs attention',
             COALESCE(action.failure_reason,'The liquidity route did not complete.'),
             CASE WHEN action.status='UNKNOWN'
               THEN 'OPES is reconciling the existing submission before any retry.'
               ELSE 'Review the route and create a new liquidity action after correcting the cause.' END,
             CASE WHEN action.status='UNKNOWN' THEN 'AUTO_RECOVERING' ELSE 'USER_ACTION' END,
             'treasury', 'Open treasury', 'liquidity_action', action.id, NULL::uuid, action.updated_at
        FROM opes.liquidity_actions action
       WHERE action.organization_id=$1 AND action.status IN ('FAILED','UNKNOWN')
      UNION ALL
      SELECT action.id, 'AGREEMENT', 'WARNING', action.status,
             'Agreement execution needs attention', COALESCE(action.failure_reason,'The onchain agreement action needs reconciliation.'),
             CASE WHEN action.status='UNKNOWN' THEN 'Reconcile the provider transaction before attempting another submission.' ELSE 'Open the agreement and verify its current state.' END,
             CASE WHEN action.status='UNKNOWN' THEN 'PLATFORM_ACTION' ELSE 'USER_ACTION' END, 'agreements', 'Open agreement', action.target_type, action.target_id,
             action.target_id, action.updated_at
        FROM opes.lifecycle_chain_actions action
       WHERE action.organization_id=$1 AND action.status IN ('FAILED','UNKNOWN')
      UNION ALL
      SELECT exception.id, 'TREASURY', 'CRITICAL', exception.status,
             replace(initcap(exception.exception_type),'_',' '),
             COALESCE(exception.details->>'message', exception.details->>'transactionHash', 'Treasury records do not match observed chain state.'),
             'Review the affected movement. OPES will resolve the exception after chain and ledger state agree.',
             'AUTO_RECOVERING', 'treasury', 'Review movement', 'treasury_exception', exception.id,
             exception.movement_id, exception.created_at
        FROM opes.treasury_exceptions exception
       WHERE exception.organization_id=$1 AND exception.status='OPEN'
      UNION ALL
      SELECT connector.id, 'INTEGRATION', 'WARNING', connector.status,
             connector.provider || ' connection failed', COALESCE(connector.last_error,'The accounting connection failed.'),
             'Check the connection settings and run synchronization again.',
             'USER_ACTION', 'integrations', 'Open integration', 'accounting_connector', connector.id,
             connector.id, connector.updated_at
        FROM opes.accounting_connector_bindings connector
       WHERE connector.organization_id=$1 AND connector.status='FAILED'
      UNION ALL
      SELECT email.id, 'INBOX', 'WARNING', email.status,
             CASE WHEN email.status='QUARANTINED' THEN 'Email quarantined' ELSE 'Email ingestion failed' END,
             COALESCE(email.quarantine_reason,email.failure_reason,'The inbound email could not be processed.'),
             'Review the sender and attachments, then submit corrected evidence if required.',
             'USER_ACTION', 'inbox', 'Open inbox', 'inbound_email', email.id, email.id, email.updated_at
        FROM opes.inbound_email_events email
       WHERE email.organization_id=$1 AND email.status IN ('FAILED','QUARANTINED')
      UNION ALL
      SELECT binding.id, 'PROVISIONING', 'CRITICAL', binding.status,
             'Workspace resource failed to provision',
             COALESCE(binding.metadata->>'failureReason','A required wallet or contract resource could not be provisioned.'),
             'Open setup, confirm funding and permissions, then retry provisioning.',
             'USER_ACTION', 'setup', 'Open setup', 'resource_binding', binding.id, binding.id, binding.updated_at
        FROM opes.tenant_resource_bindings binding
       WHERE binding.organization_id=$1 AND binding.status='FAILED'
      UNION ALL
      SELECT event.id, 'SYSTEM',
             CASE WHEN event.status='FAILED' THEN 'CRITICAL' ELSE 'WARNING' END,
             event.status, 'Background operation needs attention',
             COALESCE(event.payload->>'failureReason', replace(event.event_type,'.',' ')),
             CASE WHEN event.status='PROCESSING'
               THEN 'The worker can reclaim this operation automatically. Do not duplicate the action.'
               ELSE 'OPES operations must inspect the failed worker job before it can be retried.' END,
             CASE WHEN event.status='PROCESSING' THEN 'AUTO_RECOVERING' ELSE 'PLATFORM_ACTION' END,
             'overview', 'Open overview', 'outbox_event', event.id, event.aggregate_id, event.updated_at
        FROM opes.outbox_events event
       WHERE event.organization_id=$1
         AND (event.status='FAILED' OR (event.status='PROCESSING' AND event.updated_at < now()-interval '5 minutes'))
         AND NOT (
           event.aggregate_type='payment_execution' AND EXISTS (
             SELECT 1 FROM opes.payment_executions execution
              WHERE execution.organization_id=event.organization_id AND execution.id=event.aggregate_id
                AND execution.status IN ('FAILED','UNKNOWN')
           )
         )
         AND NOT (
           event.aggregate_type='liquidity_action' AND EXISTS (
             SELECT 1 FROM opes.liquidity_actions action
              WHERE action.organization_id=event.organization_id AND action.id=event.aggregate_id
                AND action.status IN ('FAILED','UNKNOWN')
           )
         )
    )
    SELECT id,category,severity,status,title,reason,recommendation,recovery_mode,
           action_view,action_label,subject_type,subject_id,related_record_id,updated_at
      FROM exceptions
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 100
  `;
}
