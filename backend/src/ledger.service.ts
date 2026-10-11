import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

export interface LedgerEntryResponse {
  id: string;
  ledgerEventType: string;
  ledgerEventId: string;
  lineNumber: number;
  account: string;
  direction: string;
  assetSymbol: string;
  amountAtomic: string;
  sourceType: string;
  sourceId: string;
  sourceVersionId: string | null;
  counterpartyId: string | null;
  transactionHash: string | null;
}

interface LedgerEntryRow {
  id: string;
  ledger_event_type: string;
  ledger_event_id: string;
  line_number: number;
  account: string;
  direction: string;
  asset_symbol: string;
  amount_atomic: string;
  source_type: string;
  source_id: string;
  source_version_id: string | null;
  counterparty_id: string | null;
  transaction_hash: string | null;
}

interface InvoiceLedgerSourceRow {
  version_id: string;
  obligation_id: string;
  vendor_id: string;
  currency: string;
  amount_atomic: string;
  status: string;
}

interface PaymentLedgerSourceRow {
  execution_id: string;
  decision_id: string;
  source_version_id: string;
  vendor_id: string;
  route_asset_symbol: string;
  route_environment: string;
  amount_atomic: string;
  status: string;
  transaction_hash: string | null;
}

@Injectable()
export class LedgerService {
  constructor(private readonly database: DatabaseService) {}

  async projectInvoiceAccrual(
    context: TenantContext,
    invoiceVersionId: string,
  ): Promise<LedgerEntryResponse[]> {
    return this.database.withTenant(context, async (database) => {
      await projectInvoiceAccrualInDatabase(
        database,
        context.organizationId,
        invoiceVersionId,
      );

      return mapRows(
        await getLedgerEvent(
          database,
          context.organizationId,
          'INVOICE_ACCEPTED',
          invoiceVersionId,
        ),
      );
    });
  }

  async projectPaymentSettlement(
    context: TenantContext,
    executionId: string,
  ): Promise<LedgerEntryResponse[]> {
    return this.database.withTenant(context, async (database) => {
      await projectPaymentSettlementInDatabase(
        database,
        context.organizationId,
        executionId,
      );

      return mapRows(
        await getLedgerEvent(
          database,
          context.organizationId,
          'PAYMENT_SETTLED',
          executionId,
        ),
      );
    });
  }
}

export async function projectInvoiceAccrualInDatabase(
  database: TenantDatabase,
  organizationId: string,
  invoiceVersionId: string,
): Promise<void> {
  const source = await getInvoiceSource(
    database,
    organizationId,
    invoiceVersionId,
  );
  if (source.status !== 'ACCEPTED') {
    throw new ConflictException('Only accepted invoices can be accrued');
  }
  if (source.currency !== 'USDC') {
    throw new ConflictException('Only USDC invoices can be accrued');
  }

  await insertLedgerPair(database, {
    organizationId,
    eventType: 'INVOICE_ACCEPTED',
    eventId: source.version_id,
    amountAtomic: source.amount_atomic,
    sourceType: 'PAYABLE_OBLIGATION_VERSION',
    sourceId: source.obligation_id,
    sourceVersionId: source.version_id,
    counterpartyId: source.vendor_id,
    transactionHash: null,
    debitAccount: 'EXPENSE:PAYABLES',
    creditAccount: 'LIABILITY:ACCOUNTS_PAYABLE',
  });
}

export async function projectPaymentSettlementInDatabase(
  database: TenantDatabase,
  organizationId: string,
  executionId: string,
): Promise<void> {
  const source = await getPaymentSource(database, organizationId, executionId);
  if (source.status !== 'CONFIRMED') {
    throw new ConflictException('Only confirmed payments can be settled');
  }
  if (source.transaction_hash === null) {
    throw new ConflictException(
      'Confirmed payment is missing transaction hash',
    );
  }
  if (source.route_asset_symbol !== 'USDC') {
    throw new ConflictException('Only USDC payments can be settled');
  }

  await insertLedgerPair(database, {
    organizationId,
    eventType: 'PAYMENT_SETTLED',
    eventId: source.execution_id,
    amountAtomic: source.amount_atomic,
    sourceType: 'PAYMENT_EXECUTION',
    sourceId: source.execution_id,
    sourceVersionId: source.source_version_id,
    counterpartyId: source.vendor_id,
    transactionHash: source.transaction_hash,
    debitAccount: 'LIABILITY:ACCOUNTS_PAYABLE',
    creditAccount:
      source.route_environment === 'arc-testnet'
        ? 'ASSET:OPERATING_USDC'
        : `ASSET:${source.route_environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}:USDC`,
  });
  await database.query(
    `UPDATE opes.payable_obligations AS obligation SET status = 'PAID', updated_at = now()
       FROM opes.payable_obligation_versions AS version
      WHERE version.organization_id = $1 AND version.id = $2
        AND obligation.organization_id = version.organization_id
        AND obligation.id = version.obligation_id
        AND obligation.status = 'ACCEPTED'`,
    [organizationId, source.source_version_id],
  );
}

async function getInvoiceSource(
  database: TenantDatabase,
  organizationId: string,
  invoiceVersionId: string,
): Promise<InvoiceLedgerSourceRow> {
  const result = await database.query<InvoiceLedgerSourceRow>(
    `
      SELECT
        version.id AS version_id,
        version.obligation_id,
        version.vendor_id,
        version.currency,
        version.amount_atomic::text AS amount_atomic,
        version.status
      FROM opes.payable_obligation_versions AS version
      WHERE version.organization_id = $1
        AND version.id = $2
      LIMIT 1
    `,
    [organizationId, invoiceVersionId],
  );
  return requireRow(result.rows[0], 'invoice version');
}

async function getPaymentSource(
  database: TenantDatabase,
  organizationId: string,
  executionId: string,
): Promise<PaymentLedgerSourceRow> {
  const result = await database.query<PaymentLedgerSourceRow>(
    `
      SELECT
        execution.id AS execution_id,
        execution.decision_id,
        execution.source_version_id,
        decision.vendor_id,
        execution.route_asset_symbol,
        execution.route_environment,
        execution.amount_atomic::text AS amount_atomic,
        execution.status,
        execution.transaction_hash
      FROM opes.payment_executions AS execution
      JOIN opes.payment_decisions AS decision
        ON decision.organization_id = execution.organization_id
       AND decision.id = execution.decision_id
      WHERE execution.organization_id = $1
        AND execution.id = $2
      LIMIT 1
    `,
    [organizationId, executionId],
  );
  return requireRow(result.rows[0], 'payment execution');
}

async function insertLedgerPair(
  database: TenantDatabase,
  input: {
    organizationId: string;
    eventType: 'INVOICE_ACCEPTED' | 'PAYMENT_SETTLED';
    eventId: string;
    amountAtomic: string;
    sourceType: string;
    sourceId: string;
    sourceVersionId: string;
    counterpartyId: string;
    transactionHash: string | null;
    debitAccount: string;
    creditAccount: string;
  },
): Promise<void> {
  await database.query(
    `
      INSERT INTO opes.ledger_entries (
        organization_id,
        ledger_event_type,
        ledger_event_id,
        line_number,
        account,
        direction,
        asset_symbol,
        amount_atomic,
        source_type,
        source_id,
        source_version_id,
        counterparty_id,
        transaction_hash
      )
      VALUES
        ($1, $2, $3, 1, $4, 'DEBIT', 'USDC', $5, $6, $7, $8, $9, $10),
        ($1, $2, $3, 2, $11, 'CREDIT', 'USDC', $5, $6, $7, $8, $9, $10)
      ON CONFLICT (organization_id, ledger_event_type, ledger_event_id, line_number)
      DO UPDATE SET metadata = opes.ledger_entries.metadata
    `,
    [
      input.organizationId,
      input.eventType,
      input.eventId,
      input.debitAccount,
      input.amountAtomic,
      input.sourceType,
      input.sourceId,
      input.sourceVersionId,
      input.counterpartyId,
      input.transactionHash,
      input.creditAccount,
    ],
  );
}

async function getLedgerEvent(
  database: TenantDatabase,
  organizationId: string,
  eventType: string,
  eventId: string,
): Promise<LedgerEntryRow[]> {
  const result = await database.query<LedgerEntryRow>(
    `
      SELECT
        id,
        ledger_event_type,
        ledger_event_id,
        line_number,
        account,
        direction,
        asset_symbol,
        amount_atomic::text AS amount_atomic,
        source_type,
        source_id,
        source_version_id,
        counterparty_id,
        transaction_hash
      FROM opes.ledger_entries
      WHERE organization_id = $1
        AND ledger_event_type = $2
        AND ledger_event_id = $3
      ORDER BY line_number ASC
    `,
    [organizationId, eventType, eventId],
  );
  assertBalanced(result.rows);
  return result.rows;
}

function assertBalanced(rows: LedgerEntryRow[]): void {
  const debit = rows
    .filter((row) => row.direction === 'DEBIT')
    .reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
  const credit = rows
    .filter((row) => row.direction === 'CREDIT')
    .reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
  if (rows.length !== 2 || debit !== credit) {
    throw new ConflictException('Ledger event is not balanced');
  }
}

function mapRows(rows: LedgerEntryRow[]): LedgerEntryResponse[] {
  return rows.map((row) => ({
    id: row.id,
    ledgerEventType: row.ledger_event_type,
    ledgerEventId: row.ledger_event_id,
    lineNumber: row.line_number,
    account: row.account,
    direction: row.direction,
    assetSymbol: row.asset_symbol,
    amountAtomic: row.amount_atomic,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    counterpartyId: row.counterparty_id,
    transactionHash: row.transaction_hash,
  }));
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new NotFoundException(`${name} not found`);
  }
  return row;
}
