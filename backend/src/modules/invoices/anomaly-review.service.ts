import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

interface InvoiceSignalRow {
  id: string;
  invoice_number: string;
  vendor_id: string;
  vendor_name: string;
  amount_atomic: string;
  average_atomic: string;
  sample_size: string;
  month_count: string;
  duplicate_count: string;
  created_at: Date;
}
interface AddressSignalRow {
  id: string;
  vendor_id: string;
  vendor_name: string;
  payout_address: string;
  created_at: Date;
}
export interface AnomalySignal {
  id: string;
  kind: 'DUPLICATE' | 'AMOUNT' | 'FREQUENCY' | 'PAYOUT_CHANGE';
  severity: 'INFO' | 'REVIEW';
  title: string;
  explanation: string;
  relatedRecordId: string;
  actionView: 'invoices' | 'approvals';
  observedAt: Date;
}

@Injectable()
export class AnomalyReviewService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: TenantContext) {
    return this.database.withTenant(context, async (database) => {
      const [invoices, addresses] = await Promise.all([
        database.query<InvoiceSignalRow>(
          `WITH latest AS (
          SELECT DISTINCT ON (obligation_id) id,invoice_number,vendor_id,amount_atomic,semantic_fingerprint,created_at
          FROM opes.payable_obligation_versions WHERE organization_id=$1 ORDER BY obligation_id,version DESC
        ) SELECT latest.id,latest.invoice_number,latest.vendor_id,vendor.display_name AS vendor_name,
          latest.amount_atomic::text,trunc(avg(latest.amount_atomic) OVER (PARTITION BY latest.vendor_id))::text AS average_atomic,
          count(*) OVER (PARTITION BY latest.vendor_id)::text AS sample_size,
          count(*) OVER (PARTITION BY latest.vendor_id,date_trunc('month',latest.created_at))::text AS month_count,
          count(*) OVER (PARTITION BY latest.semantic_fingerprint)::text AS duplicate_count,latest.created_at
        FROM latest JOIN opes.vendors vendor ON vendor.organization_id=$1 AND vendor.id=latest.vendor_id
        WHERE latest.created_at>=now()-interval '180 days' ORDER BY latest.created_at DESC`,
          [context.organizationId],
        ),
        database.query<AddressSignalRow>(
          `SELECT address.id,address.vendor_id,vendor.display_name AS vendor_name,address.payout_address,address.created_at
          FROM opes.vendor_payout_addresses address JOIN opes.vendors vendor ON vendor.organization_id=address.organization_id AND vendor.id=address.vendor_id
          WHERE address.organization_id=$1 AND address.status='PENDING_REVIEW' ORDER BY address.created_at DESC`,
          [context.organizationId],
        ),
      ]);
      return {
        authoritative: false,
        signals: classifyAnomalies(invoices.rows, addresses.rows),
      };
    });
  }
}

export function classifyAnomalies(
  invoices: InvoiceSignalRow[],
  addresses: AddressSignalRow[],
): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  for (const row of invoices) {
    if (Number(row.duplicate_count) > 1)
      signals.push(
        signal(
          row,
          'DUPLICATE',
          `The normalized invoice fingerprint appears ${row.duplicate_count} times.`,
        ),
      );
    if (
      Number(row.sample_size) >= 3 &&
      BigInt(row.amount_atomic) > BigInt(row.average_atomic) * 2n
    )
      signals.push(
        signal(
          row,
          'AMOUNT',
          `The amount is more than twice this vendor's 180-day average.`,
        ),
      );
    if (Number(row.month_count) >= 5)
      signals.push(
        signal(
          row,
          'FREQUENCY',
          `${row.month_count} invoices from this vendor were recorded in the same month.`,
        ),
      );
  }
  for (const row of addresses)
    signals.push({
      id: `PAYOUT_CHANGE:${row.id}`,
      kind: 'PAYOUT_CHANGE',
      severity: 'REVIEW',
      title: `${row.vendor_name} requested a payout-address change`,
      explanation: `The proposed address ${row.payout_address} remains unverified and cannot receive payments.`,
      relatedRecordId: row.vendor_id,
      actionView: 'approvals',
      observedAt: row.created_at,
    });
  return signals;
}
function signal(
  row: InvoiceSignalRow,
  kind: AnomalySignal['kind'],
  explanation: string,
): AnomalySignal {
  return {
    id: `${kind}:${row.id}`,
    kind,
    severity: 'REVIEW',
    title: `${row.invoice_number} · ${row.vendor_name}`,
    explanation,
    relatedRecordId: row.id,
    actionView: 'invoices',
    observedAt: row.created_at,
  };
}
