import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import { addPeriod } from '../agreements/lifecycle.service';
import { LiquidityService } from './liquidity.service';

type CalendarKind = 'INVOICE' | 'SUBSCRIPTION' | 'MILESTONE';

export interface PaymentCalendarItem {
  id: string;
  kind: CalendarKind;
  title: string;
  counterparty: string;
  amountAtomic: string;
  assetSymbol: string;
  scheduledFor: string | null;
  status: string;
  explanation: string;
  actionView: 'invoices' | 'agreements';
  relatedRecordId: string;
  affectsOperatingBalance: boolean;
  projectedOperatingAvailableAtomic: string | null;
}

export interface PaymentCalendarResponse {
  from: string;
  to: string;
  snapshotStatus: string;
  startingOperatingAvailableAtomic: string;
  projectedOperatingAvailableAtomic: string;
  scheduledOperatingSpendAtomic: string;
  uncoveredAtomic: string;
  items: PaymentCalendarItem[];
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  vendor_name: string;
  amount_atomic: string;
  due_at: Date | null;
  proposed_execution_at: Date | null;
  derived_action: string | null;
  execution_status: string | null;
  reserved: boolean;
}
interface CycleRow {
  id: string;
  subscription_id: string;
  vendor_name: string;
  amount_atomic: string;
  due_at: Date;
  status: string;
}
interface SubscriptionRow {
  id: string;
  vendor_name: string;
  cadence: string;
  anchor_date: string;
  amount_atomic: string;
  latest_cycle_start: string | null;
}
interface MilestoneRow {
  id: string;
  agreement_id: string;
  vendor_name: string;
  title: string;
  amount_atomic: string;
  status: string;
  accepted_at: Date | null;
}

@Injectable()
export class PaymentCalendarService {
  constructor(
    private readonly database: DatabaseService,
    private readonly liquidity: LiquidityService,
  ) {}

  async get(
    context: TenantContext,
    fromInput?: string,
    toInput?: string,
  ): Promise<PaymentCalendarResponse> {
    const from = parseDate(fromInput ?? isoDate(new Date()), 'from');
    const to = parseDate(toInput ?? addDays(from, 90), 'to');
    if (to < from) throw new BadRequestException('to must be on or after from');
    const [position, rows] = await Promise.all([
      this.liquidity.getTreasuryPosition(context),
      this.database.withTenant(context, async (database) => {
        const [invoices, cycles, subscriptions, milestones] = await Promise.all(
          [
            database.query<InvoiceRow>(invoiceSql(), [context.organizationId]),
            database.query<CycleRow>(cycleSql(), [context.organizationId]),
            database.query<SubscriptionRow>(subscriptionSql(), [
              context.organizationId,
            ]),
            database.query<MilestoneRow>(milestoneSql(), [
              context.organizationId,
            ]),
          ],
        );
        return {
          invoices: invoices.rows,
          cycles: cycles.rows,
          subscriptions: subscriptions.rows,
          milestones: milestones.rows,
        };
      }),
    ]);

    const items = buildItems(rows, from, to);
    let remaining = max(
      BigInt(position.operatingBalanceAtomic) -
        BigInt(position.operatingBufferAtomic) -
        BigInt(position.reservedAtomic) -
        BigInt(position.approvedUnsettledPaymentAtomic),
      0n,
    );
    const starting = remaining;
    let scheduled = 0n;
    for (const item of items) {
      if (!item.affectsOperatingBalance || item.scheduledFor === null) continue;
      const amount = BigInt(item.amountAtomic);
      scheduled += amount;
      remaining -= amount;
      item.projectedOperatingAvailableAtomic = max(remaining, 0n).toString();
    }
    return {
      from,
      to,
      snapshotStatus: position.snapshotStatus,
      startingOperatingAvailableAtomic: starting.toString(),
      projectedOperatingAvailableAtomic: max(remaining, 0n).toString(),
      scheduledOperatingSpendAtomic: scheduled.toString(),
      uncoveredAtomic: max(-remaining, 0n).toString(),
      items,
    };
  }
}

function buildItems(
  rows: {
    invoices: InvoiceRow[];
    cycles: CycleRow[];
    subscriptions: SubscriptionRow[];
    milestones: MilestoneRow[];
  },
  from: string,
  to: string,
): PaymentCalendarItem[] {
  const items: PaymentCalendarItem[] = rows.invoices.map((row) => {
    const scheduled = row.proposed_execution_at ?? row.due_at;
    const inFlight = ['PENDING', 'PROCESSING', 'SUBMITTED', 'UNKNOWN'].includes(
      row.execution_status ?? '',
    );
    return {
      id: `invoice:${row.id}`,
      kind: 'INVOICE',
      title: `Invoice ${row.invoice_number}`,
      counterparty: row.vendor_name,
      amountAtomic: row.amount_atomic,
      assetSymbol: 'USDC',
      scheduledFor: scheduleAtOrAfter(scheduled, from),
      status: inFlight
        ? row.execution_status!
        : (row.derived_action ?? 'AWAITING_DECISION'),
      explanation:
        scheduled && isoDate(scheduled) < from
          ? 'This unpaid obligation is overdue and needs attention now.'
          : row.proposed_execution_at
            ? 'Scheduled by the latest agent decision.'
            : row.due_at
              ? 'Scheduled from the invoice due date.'
              : 'No due date or agent schedule is recorded.',
      actionView: 'invoices',
      relatedRecordId: row.id,
      affectsOperatingBalance: !row.reserved && !inFlight,
      projectedOperatingAvailableAtomic: null,
    };
  });
  items.push(
    ...rows.cycles.map((row) => ({
      id: `cycle:${row.id}`,
      kind: 'SUBSCRIPTION' as const,
      title: 'Recurring payment cycle',
      counterparty: row.vendor_name,
      amountAtomic: row.amount_atomic,
      assetSymbol: 'USDC',
      scheduledFor: scheduleAtOrAfter(row.due_at, from),
      status: row.status,
      explanation: 'Created from the recurring agreement cadence.',
      actionView: 'agreements' as const,
      relatedRecordId: row.subscription_id,
      affectsOperatingBalance: !['PAID', 'CANCELLED', 'PROCESSING'].includes(
        row.status,
      ),
      projectedOperatingAvailableAtomic: null,
    })),
  );
  for (const row of rows.subscriptions) {
    let next = row.latest_cycle_start
      ? addPeriod(row.latest_cycle_start, row.cadence)
      : row.anchor_date;
    while (next < from) next = addPeriod(next, row.cadence);
    while (next <= to) {
      if (
        !rows.cycles.some(
          (cycle) =>
            cycle.subscription_id === row.id && isoDate(cycle.due_at) === next,
        )
      ) {
        items.push({
          id: `renewal:${row.id}:${next}`,
          kind: 'SUBSCRIPTION',
          title: `${row.cadence.toLowerCase()} renewal`,
          counterparty: row.vendor_name,
          amountAtomic: row.amount_atomic,
          assetSymbol: 'USDC',
          scheduledFor: `${next}T00:00:00.000Z`,
          status: 'UPCOMING',
          explanation: 'Forecast from the active recurring agreement cadence.',
          actionView: 'agreements',
          relatedRecordId: row.id,
          affectsOperatingBalance: true,
          projectedOperatingAvailableAtomic: null,
        });
      }
      next = addPeriod(next, row.cadence);
    }
  }
  items.push(
    ...rows.milestones.map((row) => ({
      id: `milestone:${row.id}`,
      kind: 'MILESTONE' as const,
      title: row.title,
      counterparty: row.vendor_name,
      amountAtomic: row.amount_atomic,
      assetSymbol: 'USDC',
      scheduledFor: scheduleAtOrAfter(row.accepted_at, from),
      status: row.status,
      explanation: row.accepted_at
        ? 'Ready for release after milestone acceptance.'
        : 'No release date exists until milestone evidence is accepted.',
      actionView: 'agreements' as const,
      relatedRecordId: row.agreement_id,
      affectsOperatingBalance: false,
      projectedOperatingAvailableAtomic: null,
    })),
  );
  return items
    .filter((item) => {
      if (item.scheduledFor === null) return true;
      const date = item.scheduledFor.slice(0, 10);
      return date >= from && date <= to;
    })
    .sort((a, b) =>
      a.scheduledFor === null
        ? 1
        : b.scheduledFor === null
          ? -1
          : a.scheduledFor.localeCompare(b.scheduledFor),
    );
}

function invoiceSql() {
  return `SELECT version.id,version.invoice_number,vendor.display_name AS vendor_name,
    version.amount_atomic::text,version.due_at,decision.proposed_execution_at,
    decision.derived_action,execution.status AS execution_status,
    EXISTS(SELECT 1 FROM opes.treasury_reservations reservation WHERE reservation.organization_id=version.organization_id AND reservation.source_version_id=version.id AND reservation.status='ACTIVE' AND reservation.expires_at>now()) AS reserved
    FROM opes.payable_obligation_versions version
    JOIN opes.payable_obligations obligation ON obligation.organization_id=version.organization_id AND obligation.id=version.obligation_id
    JOIN opes.vendors vendor ON vendor.organization_id=version.organization_id AND vendor.id=version.vendor_id
    LEFT JOIN LATERAL (SELECT proposed_execution_at,derived_action FROM opes.payment_decisions current WHERE current.organization_id=version.organization_id AND current.source_version_id=version.id ORDER BY decision_version DESC LIMIT 1) decision ON true
    LEFT JOIN LATERAL (SELECT status FROM opes.payment_executions current WHERE current.organization_id=version.organization_id AND current.source_version_id=version.id ORDER BY requested_at DESC LIMIT 1) execution ON true
    WHERE version.organization_id=$1 AND version.status='ACCEPTED' AND obligation.status='ACCEPTED'
      AND NOT EXISTS(SELECT 1 FROM opes.payment_executions paid WHERE paid.organization_id=version.organization_id AND paid.source_version_id=version.id AND paid.status='CONFIRMED')`;
}
function cycleSql() {
  return `SELECT cycle.id,cycle.subscription_id,vendor.display_name AS vendor_name,cycle.amount_atomic::text,cycle.due_at,cycle.status
    FROM opes.subscription_cycles cycle JOIN opes.subscriptions subscription ON subscription.organization_id=cycle.organization_id AND subscription.id=cycle.subscription_id
    JOIN opes.vendors vendor ON vendor.organization_id=subscription.organization_id AND vendor.id=subscription.vendor_id
    WHERE cycle.organization_id=$1 AND cycle.status NOT IN ('PAID','CANCELLED')`;
}
function subscriptionSql() {
  return `SELECT subscription.id,vendor.display_name AS vendor_name,version.cadence,version.anchor_date::text,version.amount_atomic::text,
    (SELECT max(cycle.service_period_start)::text FROM opes.subscription_cycles cycle WHERE cycle.organization_id=subscription.organization_id AND cycle.subscription_id=subscription.id) AS latest_cycle_start
    FROM opes.subscriptions subscription JOIN opes.vendors vendor ON vendor.organization_id=subscription.organization_id AND vendor.id=subscription.vendor_id
    JOIN LATERAL (SELECT * FROM opes.subscription_versions current WHERE current.organization_id=subscription.organization_id AND current.subscription_id=subscription.id AND current.status='ACTIVE' ORDER BY version DESC LIMIT 1) version ON true
    WHERE subscription.organization_id=$1 AND subscription.status='ACTIVE'`;
}
function milestoneSql() {
  return `SELECT milestone.id,milestone.agreement_id,vendor.display_name AS vendor_name,milestone.title,milestone.amount_atomic::text,milestone.status,milestone.accepted_at
    FROM opes.escrow_milestones milestone JOIN opes.escrow_agreements agreement ON agreement.organization_id=milestone.organization_id AND agreement.id=milestone.agreement_id
    JOIN opes.vendors vendor ON vendor.organization_id=agreement.organization_id AND vendor.id=agreement.vendor_id
    WHERE milestone.organization_id=$1 AND agreement.status NOT IN ('CANCELLED','COMPLETED') AND milestone.status NOT IN ('RELEASED','REFUNDED')`;
}
function parseDate(value: string, field: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  return value;
}
function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}
function scheduleAtOrAfter(value: Date | null, from: string) {
  if (value === null) return null;
  return isoDate(value) < from ? `${from}T00:00:00.000Z` : value.toISOString();
}
function max(left: bigint, right: bigint) {
  return left > right ? left : right;
}
