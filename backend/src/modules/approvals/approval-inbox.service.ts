import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

type ApprovalKind = 'PAYMENT_LIMIT' | 'PAYOUT_ADDRESS' | 'MILESTONE';
type ApprovalRole = 'OWNER' | 'ADMIN' | 'APPROVER';

interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  title: string;
  reason: string;
  amount_atomic: string | null;
  asset_symbol: string | null;
  expires_at: Date | null;
  requested_at: Date;
  action_view: 'invoices' | 'agreements';
  related_record_id: string;
}

const approvalRoles: ApprovalRole[] = ['OWNER', 'ADMIN', 'APPROVER'];

@Injectable()
export class ApprovalInboxService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext) {
    return this.database.withTenant(context, async (database) => {
      const result = await database.query<ApprovalRow>(approvalSql, [
        context.organizationId,
      ]);
      const now = Date.now();
      const items = result.rows.map((row) => {
        const expired =
          row.expires_at !== null && row.expires_at.getTime() <= now;
        return {
          id: row.id,
          kind: row.kind,
          title: row.title,
          reason: row.reason,
          amountAtomic: row.amount_atomic,
          assetSymbol: row.asset_symbol,
          expiresAt: row.expires_at?.toISOString() ?? null,
          requestedAt: row.requested_at.toISOString(),
          requiredRoles: approvalRoles,
          canAct:
            approvalRoles.includes(context.role as ApprovalRole) && !expired,
          status: expired ? 'EXPIRED' : 'AWAITING_APPROVAL',
          actionView: row.action_view,
          relatedRecordId: row.related_record_id,
        };
      });
      return {
        items,
        summary: {
          total: items.length,
          actionable: items.filter((item) => item.canAct).length,
          expiring: items.filter(
            (item) => item.expiresAt !== null && !item.canAct,
          ).length,
        },
      };
    });
  }
}

const approvalSql = `
  SELECT decision.id,'PAYMENT_LIMIT'::text AS kind,
    'Approve invoice ' || version.invoice_number AS title,
    COALESCE((SELECT item->>'message' FROM jsonb_array_elements(decision.checks) item WHERE item->>'status'='REQUIRES_APPROVAL' LIMIT 1),'Payment exceeds autonomous authority.') AS reason,
    decision.amount_atomic::text,NULLIF(decision.route_asset_symbol,'') AS asset_symbol,
    decision.expires_at,decision.created_at AS requested_at,'invoices'::text AS action_view,
    decision.source_version_id AS related_record_id
  FROM opes.payment_decisions decision
  JOIN opes.payable_obligation_versions version ON version.organization_id=decision.organization_id AND version.id=decision.source_version_id
  WHERE decision.organization_id=$1 AND decision.derived_action='ESCALATE'
    AND NOT EXISTS (SELECT 1 FROM opes.payment_decision_approvals approval WHERE approval.organization_id=decision.organization_id AND approval.decision_id=decision.id AND approval.status='ACTIVE' AND approval.expires_at>now())
  UNION ALL
  SELECT address.id,'PAYOUT_ADDRESS',vendor.display_name || ' changed payout address',
    'Verify the replacement wallet before it can receive payments.',NULL,NULL,NULL,address.created_at,
    'invoices',address.vendor_id
  FROM opes.vendor_payout_addresses address
  JOIN opes.vendors vendor ON vendor.organization_id=address.organization_id AND vendor.id=address.vendor_id
  WHERE address.organization_id=$1 AND address.status='PENDING_REVIEW'
  UNION ALL
  SELECT milestone.id,'MILESTONE','Accept milestone: ' || milestone.title,
    'Review submitted delivery evidence before authorizing release.',milestone.amount_atomic::text,
    agreement.currency,NULL,milestone.updated_at,'agreements',milestone.agreement_id
  FROM opes.escrow_milestones milestone
  JOIN opes.escrow_agreements agreement ON agreement.organization_id=milestone.organization_id AND agreement.id=milestone.agreement_id
  WHERE milestone.organization_id=$1 AND milestone.status='SUBMITTED'
  ORDER BY requested_at DESC`;
