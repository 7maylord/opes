import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

const USDC_DECIMALS = 6;

export interface CreateSubscriptionRequest {
  vendorId: string;
  vendorAddressId: string;
  cadence: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  anchorDate: string;
  timezone: string;
  amount: string;
  termsDocumentId?: string;
}

export interface SubscriptionResponse {
  id: string;
  versionId: string;
  version: number;
  status: string;
  cadence: string;
  anchorDate: string;
  timezone: string;
  amountAtomic: string;
}

export interface CreateSubscriptionCycleRequest {
  servicePeriodStart: string;
}

export interface SubscriptionCycleResponse {
  id: string;
  subscriptionId: string;
  subscriptionVersionId: string;
  servicePeriodStart: string;
  servicePeriodEnd: string;
  dueAt: string;
  amountAtomic: string;
  status: string;
}

export interface CreateEscrowAgreementRequest {
  vendorId: string;
  vendorAddressId: string;
  agreementDocumentId?: string;
  totalAmount: string;
  milestones: Array<{
    title: string;
    amount: string;
  }>;
}

export interface EscrowAgreementResponse {
  id: string;
  status: string;
  totalAmountAtomic: string;
  milestones: EscrowMilestoneResponse[];
}

export interface EscrowMilestoneResponse {
  id: string;
  agreementId: string;
  milestoneIndex: number;
  title: string;
  amountAtomic: string;
  status: string;
  evidenceDocumentId: string | null;
}

interface VendorRow {
  id: string;
  status: string;
}

interface AddressRow {
  id: string;
  vendor_id: string;
  status: string;
  asset_symbol: string;
}

interface SubscriptionRow {
  id: string;
  status: string;
}

interface SubscriptionVersionRow {
  id: string;
  version: number;
  cadence: string;
  anchor_date: string;
  timezone: string;
  amount_atomic: string;
}

interface CycleRow {
  id: string;
  subscription_id: string;
  subscription_version_id: string;
  service_period_start: string;
  service_period_end: string;
  due_at: Date;
  amount_atomic: string;
  status: string;
}

interface AgreementRow {
  id: string;
  status: string;
  total_amount_atomic: string;
}

interface MilestoneRow {
  id: string;
  agreement_id: string;
  milestone_index: number;
  title: string;
  amount_atomic: string;
  status: string;
  evidence_document_id: string | null;
}

@Injectable()
export class LifecycleService {
  constructor(private readonly database: DatabaseService) {}

  async createSubscription(
    context: TenantContext,
    input: CreateSubscriptionRequest,
  ): Promise<SubscriptionResponse> {
    requireOwnerOrAdmin(context);
    const vendorId = requireUuid(input.vendorId, 'vendorId');
    const vendorAddressId = requireUuid(
      input.vendorAddressId,
      'vendorAddressId',
    );
    const cadence = validateCadence(input.cadence);
    const anchorDate = validateDate(input.anchorDate, 'anchorDate');
    const timezone = requireText(input.timezone, 'timezone');
    const amountAtomic = parseAtomicAmount(input.amount, 'amount');
    const termsDocumentId = input.termsDocumentId
      ? requireUuid(input.termsDocumentId, 'termsDocumentId')
      : null;

    return this.database.withTenant(context, async (database) => {
      await requireVerifiedPayee(
        database,
        context.organizationId,
        vendorId,
        vendorAddressId,
      );
      if (termsDocumentId !== null) {
        await requireDocument(
          database,
          context.organizationId,
          termsDocumentId,
        );
      }

      const subscription = await database.query<SubscriptionRow>(
        `
          INSERT INTO opes.subscriptions (
            organization_id,
            vendor_id,
            vendor_address_id,
            created_by_membership_id
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id, status
        `,
        [
          context.organizationId,
          vendorId,
          vendorAddressId,
          context.membershipId,
        ],
      );
      const row = requireRow(subscription.rows[0], 'subscription');

      const version = await database.query<SubscriptionVersionRow>(
        `
          INSERT INTO opes.subscription_versions (
            organization_id,
            subscription_id,
            version,
            cadence,
            timezone,
            anchor_date,
            amount_atomic,
            terms_document_id,
            created_by_membership_id
          )
          VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
          RETURNING id, version, cadence, anchor_date, timezone, amount_atomic
        `,
        [
          context.organizationId,
          row.id,
          cadence,
          timezone,
          anchorDate,
          amountAtomic.toString(),
          termsDocumentId,
          context.membershipId,
        ],
      );
      const versionRow = requireRow(version.rows[0], 'subscription version');

      return {
        id: row.id,
        versionId: versionRow.id,
        version: versionRow.version,
        status: row.status,
        cadence: versionRow.cadence,
        anchorDate: dateValueToIso(versionRow.anchor_date),
        timezone: versionRow.timezone,
        amountAtomic: versionRow.amount_atomic,
      };
    });
  }

  async createSubscriptionCycle(
    context: TenantContext,
    subscriptionId: string,
    input: CreateSubscriptionCycleRequest,
  ): Promise<SubscriptionCycleResponse> {
    const targetSubscriptionId = requireUuid(subscriptionId, 'subscriptionId');
    const start = validateDate(input.servicePeriodStart, 'servicePeriodStart');

    return this.database.withTenant(context, async (database) => {
      const subscription = await getSubscription(
        database,
        context.organizationId,
        targetSubscriptionId,
      );
      if (subscription.status !== 'ACTIVE') {
        throw new ConflictException('Subscription is not active');
      }
      const version = await getActiveSubscriptionVersion(
        database,
        context.organizationId,
        targetSubscriptionId,
      );
      const end = addPeriod(start, version.cadence);
      const dueAt = dueAtUtc(start, version.timezone);

      const inserted = await database.query<CycleRow>(
        `
          INSERT INTO opes.subscription_cycles (
            organization_id,
            subscription_id,
            subscription_version_id,
            service_period_start,
            service_period_end,
            due_at,
            amount_atomic
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (organization_id, subscription_id, service_period_start, service_period_end)
          DO UPDATE SET subscription_id = opes.subscription_cycles.subscription_id
          RETURNING
            id,
            subscription_id,
            subscription_version_id,
            service_period_start,
            service_period_end,
            due_at,
            amount_atomic,
            status
        `,
        [
          context.organizationId,
          targetSubscriptionId,
          version.id,
          start,
          end,
          dueAt,
          version.amount_atomic,
        ],
      );

      return mapCycle(requireRow(inserted.rows[0], 'subscription cycle'));
    });
  }

  async cancelSubscription(
    context: TenantContext,
    subscriptionId: string,
  ): Promise<{ id: string; status: string }> {
    requireOwnerOrAdmin(context);
    const targetSubscriptionId = requireUuid(subscriptionId, 'subscriptionId');
    const result = await this.database.withTenant(context, (database) =>
      database.query<SubscriptionRow>(
        `
          UPDATE opes.subscriptions
             SET status = 'CANCELLED',
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status <> 'CANCELLED'
          RETURNING id, status
        `,
        [context.organizationId, targetSubscriptionId],
      ),
    );
    const row = requireRow(result.rows[0], 'subscription');
    return { id: row.id, status: row.status };
  }

  async createEscrowAgreement(
    context: TenantContext,
    input: CreateEscrowAgreementRequest,
  ): Promise<EscrowAgreementResponse> {
    requireOwnerOrAdmin(context);
    const vendorId = requireUuid(input.vendorId, 'vendorId');
    const vendorAddressId = requireUuid(
      input.vendorAddressId,
      'vendorAddressId',
    );
    const agreementDocumentId = input.agreementDocumentId
      ? requireUuid(input.agreementDocumentId, 'agreementDocumentId')
      : null;
    const totalAmount = parseAtomicAmount(input.totalAmount, 'totalAmount');
    const milestones = normalizeMilestones(input.milestones);
    const milestoneTotal = milestones.reduce(
      (sum, milestone) => sum + milestone.amountAtomic,
      0n,
    );
    if (milestoneTotal !== totalAmount) {
      throw new BadRequestException(
        'milestone total does not match agreement total',
      );
    }

    return this.database.withTenant(context, async (database) => {
      await requireVerifiedPayee(
        database,
        context.organizationId,
        vendorId,
        vendorAddressId,
      );
      if (agreementDocumentId !== null) {
        await requireDocument(
          database,
          context.organizationId,
          agreementDocumentId,
        );
      }

      const agreement = await database.query<AgreementRow>(
        `
          INSERT INTO opes.escrow_agreements (
            organization_id,
            vendor_id,
            vendor_address_id,
            total_amount_atomic,
            agreement_document_id,
            created_by_membership_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, status, total_amount_atomic
        `,
        [
          context.organizationId,
          vendorId,
          vendorAddressId,
          totalAmount.toString(),
          agreementDocumentId,
          context.membershipId,
        ],
      );
      const agreementRow = requireRow(agreement.rows[0], 'escrow agreement');
      const milestoneRows: MilestoneRow[] = [];
      for (const [index, milestone] of milestones.entries()) {
        const inserted = await database.query<MilestoneRow>(
          `
            INSERT INTO opes.escrow_milestones (
              organization_id,
              agreement_id,
              milestone_index,
              title,
              amount_atomic
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING
              id,
              agreement_id,
              milestone_index,
              title,
              amount_atomic,
              status,
              evidence_document_id
          `,
          [
            context.organizationId,
            agreementRow.id,
            index,
            milestone.title,
            milestone.amountAtomic.toString(),
          ],
        );
        milestoneRows.push(requireRow(inserted.rows[0], 'escrow milestone'));
      }

      return {
        id: agreementRow.id,
        status: agreementRow.status,
        totalAmountAtomic: agreementRow.total_amount_atomic,
        milestones: milestoneRows.map(mapMilestone),
      };
    });
  }

  async submitMilestoneEvidence(
    context: TenantContext,
    milestoneId: string,
    evidenceDocumentId: string,
  ): Promise<EscrowMilestoneResponse> {
    const targetMilestoneId = requireUuid(milestoneId, 'milestoneId');
    const documentId = requireUuid(evidenceDocumentId, 'evidenceDocumentId');

    return this.database.withTenant(context, async (database) => {
      await requireDocument(database, context.organizationId, documentId);
      const updated = await database.query<MilestoneRow>(
        `
          UPDATE opes.escrow_milestones
             SET status = 'SUBMITTED',
                 evidence_document_id = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status IN ('PENDING', 'SUBMITTED')
          RETURNING
            id,
            agreement_id,
            milestone_index,
            title,
            amount_atomic,
            status,
            evidence_document_id
        `,
        [context.organizationId, targetMilestoneId, documentId],
      );
      return mapMilestone(requireRow(updated.rows[0], 'escrow milestone'));
    });
  }

  async acceptMilestone(
    context: TenantContext,
    milestoneId: string,
  ): Promise<EscrowMilestoneResponse> {
    requireVerifierRole(context);
    const targetMilestoneId = requireUuid(milestoneId, 'milestoneId');

    const result = await this.database.withTenant(context, (database) =>
      database.query<MilestoneRow>(
        `
          UPDATE opes.escrow_milestones
             SET status = 'ACCEPTED',
                 accepted_by_membership_id = $3,
                 accepted_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status = 'SUBMITTED'
             AND evidence_document_id IS NOT NULL
          RETURNING
            id,
            agreement_id,
            milestone_index,
            title,
            amount_atomic,
            status,
            evidence_document_id
        `,
        [context.organizationId, targetMilestoneId, context.membershipId],
      ),
    );
    return mapMilestone(requireRow(result.rows[0], 'escrow milestone'));
  }

  async disputeMilestone(
    context: TenantContext,
    milestoneId: string,
    reason: string,
  ): Promise<EscrowMilestoneResponse> {
    requireVerifierRole(context);
    const targetMilestoneId = requireUuid(milestoneId, 'milestoneId');
    const disputeReason = requireText(reason, 'reason');

    return this.database.withTenant(context, async (database) => {
      const updated = await database.query<MilestoneRow>(
        `
          UPDATE opes.escrow_milestones
             SET status = 'DISPUTED',
                 dispute_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status IN ('SUBMITTED', 'ACCEPTED', 'DISPUTED')
          RETURNING
            id,
            agreement_id,
            milestone_index,
            title,
            amount_atomic,
            status,
            evidence_document_id
        `,
        [context.organizationId, targetMilestoneId, disputeReason],
      );
      const milestone = requireRow(updated.rows[0], 'escrow milestone');
      await database.query(
        `
          UPDATE opes.escrow_agreements
             SET status = 'DISPUTED',
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status = 'ACTIVE'
        `,
        [context.organizationId, milestone.agreement_id],
      );
      return mapMilestone(milestone);
    });
  }
}

async function requireVerifiedPayee(
  database: TenantDatabase,
  organizationId: string,
  vendorId: string,
  addressId: string,
): Promise<void> {
  const vendor = await database.query<VendorRow>(
    `
      SELECT id, status
        FROM opes.vendors
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, vendorId],
  );
  if (requireRow(vendor.rows[0], 'vendor').status !== 'VERIFIED') {
    throw new ConflictException('Vendor is not verified');
  }

  const address = await database.query<AddressRow>(
    `
      SELECT id, vendor_id, status, asset_symbol
        FROM opes.vendor_payout_addresses
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, addressId],
  );
  const row = requireRow(address.rows[0], 'vendor payout address');
  if (row.vendor_id !== vendorId) {
    throw new BadRequestException('vendorAddressId does not belong to vendor');
  }
  if (row.status !== 'VERIFIED_ACTIVE') {
    throw new ConflictException('Vendor payout address is not active');
  }
  if (row.asset_symbol !== 'USDC') {
    throw new BadRequestException('Vendor payout asset must be USDC');
  }
}

async function requireDocument(
  database: TenantDatabase,
  organizationId: string,
  documentId: string,
): Promise<void> {
  const result = await database.query(
    `
      SELECT id
        FROM opes.evidence_documents
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, documentId],
  );
  if (result.rows[0] === undefined) {
    throw new NotFoundException('Evidence document not found');
  }
}

async function getSubscription(
  database: TenantDatabase,
  organizationId: string,
  subscriptionId: string,
): Promise<SubscriptionRow> {
  const result = await database.query<SubscriptionRow>(
    `
      SELECT id, status
        FROM opes.subscriptions
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, subscriptionId],
  );
  return requireRow(result.rows[0], 'subscription');
}

async function getActiveSubscriptionVersion(
  database: TenantDatabase,
  organizationId: string,
  subscriptionId: string,
): Promise<SubscriptionVersionRow> {
  const result = await database.query<SubscriptionVersionRow>(
    `
      SELECT id, version, cadence, anchor_date, timezone, amount_atomic
        FROM opes.subscription_versions
       WHERE organization_id = $1
         AND subscription_id = $2
         AND status = 'ACTIVE'
       ORDER BY version DESC
       LIMIT 1
    `,
    [organizationId, subscriptionId],
  );
  return requireRow(result.rows[0], 'subscription version');
}

interface NormalizedMilestone {
  title: string;
  amountAtomic: bigint;
}

function normalizeMilestones(
  milestones: CreateEscrowAgreementRequest['milestones'],
): NormalizedMilestone[] {
  if (
    !Array.isArray(milestones) ||
    milestones.length < 1 ||
    milestones.length > 5
  ) {
    throw new BadRequestException('milestones must contain 1 to 5 entries');
  }
  return milestones.map((milestone, index) => ({
    title: requireText(milestone.title, `milestones.${index}.title`),
    amountAtomic: parseAtomicAmount(
      milestone.amount,
      `milestones.${index}.amount`,
    ),
  }));
}

function addPeriod(date: string, cadence: string): string {
  if (cadence === 'WEEKLY') {
    return addDays(date, 7);
  }
  if (cadence === 'MONTHLY') {
    return addMonths(date, 1);
  }
  if (cadence === 'QUARTERLY') {
    return addMonths(date, 3);
  }
  return addMonths(date, 12);
}

function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  const utc = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + days),
  );
  return formatDate(
    utc.getUTCFullYear(),
    utc.getUTCMonth() + 1,
    utc.getUTCDate(),
  );
}

function addMonths(date: string, months: number): string {
  const parsed = parseDate(date);
  const targetMonth = parsed.month - 1 + months;
  const targetYear = parsed.year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(
    parsed.day,
    daysInMonth(targetYear, normalizedMonth + 1),
  );
  return formatDate(targetYear, normalizedMonth + 1, day);
}

function dueAtUtc(date: string, timezone: string): string {
  // ponytail: noon local avoids most DST gaps; replace with Temporal when Node ships it broadly.
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  formatter.format(new Date(`${date}T12:00:00Z`));
  return `${date}T12:00:00.000Z`;
}

function validateDate(value: string, name: string): string {
  const text = requireText(value, name);
  const parsed = parseDate(text);
  if (formatDate(parsed.year, parsed.month, parsed.day) !== text) {
    throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  }
  return text;
}

function parseDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new BadRequestException('date must be YYYY-MM-DD');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new BadRequestException('date must be valid');
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function validateCadence(value: string): string {
  if (!['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'].includes(value)) {
    throw new BadRequestException('cadence is invalid');
  }
  return value;
}

function parseAtomicAmount(value: string, name: string): bigint {
  const text = requireText(value, name);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new BadRequestException(`${name} must be a positive decimal string`);
  }
  const [whole, fractional = ''] = text.split('.');
  if (fractional.length > USDC_DECIMALS) {
    throw new BadRequestException(`${name} exceeds 6 decimal places`);
  }
  const atomic = BigInt(whole + fractional.padEnd(USDC_DECIMALS, '0'));
  if (atomic <= 0n) {
    throw new BadRequestException(`${name} must be greater than zero`);
  }
  return atomic;
}

function requireOwnerOrAdmin(context: TenantContext): void {
  if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
    throw new ForbiddenException(
      'Only owners and admins can manage lifecycle terms',
    );
  }
}

function requireVerifierRole(context: TenantContext): void {
  if (
    context.role !== 'OWNER' &&
    context.role !== 'ADMIN' &&
    context.role !== 'APPROVER'
  ) {
    throw new ForbiddenException(
      'Only owners, admins and approvers can accept milestones',
    );
  }
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text === '') {
    throw new BadRequestException(`${name} is required`);
  }
  return text;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return text;
}

function dateValueToIso(value: string | Date): string {
  if (value instanceof Date) {
    return formatDate(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
    );
  }
  return value.slice(0, 10);
}

function timestampValueToIso(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function mapCycle(row: CycleRow): SubscriptionCycleResponse {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    subscriptionVersionId: row.subscription_version_id,
    servicePeriodStart: dateValueToIso(row.service_period_start),
    servicePeriodEnd: dateValueToIso(row.service_period_end),
    dueAt: timestampValueToIso(row.due_at),
    amountAtomic: row.amount_atomic,
    status: row.status,
  };
}

function mapMilestone(row: MilestoneRow): EscrowMilestoneResponse {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    milestoneIndex: row.milestone_index,
    title: row.title,
    amountAtomic: row.amount_atomic,
    status: row.status,
    evidenceDocumentId: row.evidence_document_id,
  };
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new NotFoundException(`${name} not found`);
  }
  return row;
}
