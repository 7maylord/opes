import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

interface ExecutionRow {
  id: string;
  amount_atomic: string;
  vendor_id: string;
  route_asset_symbol: string;
  route_environment: string;
  transaction_hash: string;
}
interface CorrectionRow {
  id: string;
  correction_type: 'CREDIT_NOTE' | 'REFUND';
  original_execution_id: string;
  credit_note_id: string | null;
  amount_atomic: string;
  reason: string;
  transaction_hash: string | null;
  status: string;
  created_at: Date;
}
export interface CreateCorrectionRequest {
  type: 'CREDIT_NOTE' | 'REFUND';
  executionId: string;
  creditNoteId?: string;
  amountAtomic: string;
  reason: string;
  transactionHash?: string;
}

@Injectable()
export class PaymentCorrectionService {
  constructor(private readonly database: DatabaseService) {}
  async list(context: TenantContext) {
    return this.database.withTenant(context, (db) =>
      db
        .query<CorrectionRow>(
          `SELECT id,correction_type,original_execution_id,credit_note_id,amount_atomic::text,reason,transaction_hash,status,created_at FROM opes.payment_corrections WHERE organization_id=$1 ORDER BY created_at DESC`,
          [context.organizationId],
        )
        .then((result) => result.rows.map(mapCorrection)),
    );
  }

  async create(context: TenantContext, input: CreateCorrectionRequest) {
    if (!['OWNER', 'ADMIN'].includes(context.role))
      throw new ForbiddenException(
        'Only owners and admins can post payment corrections',
      );
    requireUuid(input.executionId, 'executionId');
    if (
      !/^[0-9]+$/.test(input.amountAtomic) ||
      BigInt(input.amountAtomic) <= 0n
    )
      throw new BadRequestException('amountAtomic must be a positive integer');
    const reason = input.reason?.trim();
    if (!reason || reason.length < 3 || reason.length > 500)
      throw new BadRequestException(
        'reason must be between 3 and 500 characters',
      );
    if (
      input.type === 'REFUND' &&
      !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash ?? '')
    )
      throw new BadRequestException('A refund transaction hash is required');
    if (input.type === 'REFUND')
      requireUuid(input.creditNoteId ?? '', 'creditNoteId');
    return this.database.withTenant(context, async (db) => {
      const execution = (
        await db.query<ExecutionRow>(
          `SELECT execution.id,execution.amount_atomic::text,version.vendor_id,execution.route_asset_symbol,execution.route_environment,execution.transaction_hash FROM opes.payment_executions execution JOIN opes.payable_obligation_versions version ON version.organization_id=execution.organization_id AND version.id=execution.source_version_id WHERE execution.organization_id=$1 AND execution.id=$2 AND execution.status='CONFIRMED' FOR UPDATE`,
          [context.organizationId, input.executionId],
        )
      ).rows[0];
      if (!execution)
        throw new NotFoundException('Confirmed payment execution not found');
      if (execution.route_asset_symbol !== 'USDC')
        throw new ConflictException('Only USDC corrections are supported');
      if (input.type === 'CREDIT_NOTE')
        await assertCreditCapacity(
          db,
          context.organizationId,
          execution,
          BigInt(input.amountAtomic),
        );
      else
        await assertRefundCapacity(
          db,
          context.organizationId,
          execution.id,
          input.creditNoteId,
          BigInt(input.amountAtomic),
        );
      const inserted = await db.query<CorrectionRow>(
        `INSERT INTO opes.payment_corrections(organization_id,correction_type,original_execution_id,credit_note_id,amount_atomic,reason,transaction_hash,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,correction_type,original_execution_id,credit_note_id,amount_atomic::text,reason,transaction_hash,status,created_at`,
        [
          context.organizationId,
          input.type,
          execution.id,
          input.creditNoteId ?? null,
          input.amountAtomic,
          reason,
          input.transactionHash ?? null,
          context.membershipId,
        ],
      );
      const correction = inserted.rows[0];
      if (!correction)
        throw new ConflictException('Payment correction was not created');
      const isRefund = input.type === 'REFUND';
      await db.query(
        `INSERT INTO opes.ledger_entries(organization_id,ledger_event_type,ledger_event_id,line_number,account,direction,asset_symbol,amount_atomic,source_type,source_id,counterparty_id,transaction_hash,metadata) VALUES
        ($1,$2,$3,1,$4,'DEBIT','USDC',$5,'PAYMENT_CORRECTION',$3,$6,$7,$8::jsonb),
        ($1,$2,$3,2,$9,'CREDIT','USDC',$5,'PAYMENT_CORRECTION',$3,$6,$7,$8::jsonb)`,
        [
          context.organizationId,
          isRefund ? 'REFUND_POSTED' : 'CREDIT_NOTE_POSTED',
          correction.id,
          isRefund ? 'ASSET:OPERATING_USDC' : 'ASSET:VENDOR_CREDIT',
          input.amountAtomic,
          execution.vendor_id,
          input.transactionHash ?? null,
          JSON.stringify({
            originalExecutionId: execution.id,
            originalTransactionHash: execution.transaction_hash,
          }),
          isRefund ? 'ASSET:VENDOR_CREDIT' : 'EXPENSE:PAYABLES',
        ],
      );
      return mapCorrection(correction);
    });
  }
}

async function assertCreditCapacity(
  db: TenantDatabase,
  organizationId: string,
  execution: ExecutionRow,
  amount: bigint,
) {
  const row = (
    await db.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_atomic),0)::text AS total FROM opes.payment_corrections WHERE organization_id=$1 AND original_execution_id=$2 AND correction_type='CREDIT_NOTE'`,
      [organizationId, execution.id],
    )
  ).rows[0];
  if (BigInt(row.total) + amount > BigInt(execution.amount_atomic))
    throw new ConflictException(
      'Credit notes cannot exceed the original payment',
    );
}
async function assertRefundCapacity(
  db: TenantDatabase,
  organizationId: string,
  executionId: string,
  creditNoteId: string | undefined,
  amount: bigint,
) {
  if (!creditNoteId)
    throw new BadRequestException('creditNoteId is required for refunds');
  const row = (
    await db.query<{ amount_atomic: string; refunded: string }>(
      `SELECT note.amount_atomic::text,COALESCE(sum(refund.amount_atomic),0)::text AS refunded FROM opes.payment_corrections note LEFT JOIN opes.payment_corrections refund ON refund.organization_id=note.organization_id AND refund.credit_note_id=note.id WHERE note.organization_id=$1 AND note.id=$2 AND note.original_execution_id=$3 AND note.correction_type='CREDIT_NOTE' GROUP BY note.amount_atomic`,
      [organizationId, creditNoteId, executionId],
    )
  ).rows[0];
  if (!row)
    throw new NotFoundException('Credit note not found for this payment');
  if (BigInt(row.refunded) + amount > BigInt(row.amount_atomic))
    throw new ConflictException('Refunds cannot exceed the linked credit note');
}
function mapCorrection(row: CorrectionRow) {
  return {
    id: row.id,
    type: row.correction_type,
    executionId: row.original_execution_id,
    creditNoteId: row.credit_note_id,
    amountAtomic: row.amount_atomic,
    reason: row.reason,
    transactionHash: row.transaction_hash,
    status: row.status,
    createdAt: row.created_at,
  };
}
function requireUuid(value: string, field: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException(`${field} must be a UUID`);
}
