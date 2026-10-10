import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from './database.service';

export interface PaymentWebhookRequest {
  organizationId: string;
  provider: string;
  externalEventId: string;
  signature: string;
  payload: {
    executionId?: string;
    transactionHash?: string;
    status?: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
    chainId?: number;
    to?: string;
    callData?: string;
  };
}

export interface PaymentReconciliationResponse {
  id: string;
  duplicate: boolean;
  status: string;
}

interface ReconciliationRow {
  id: string;
  status: string;
  duplicate: boolean;
}

@Injectable()
export class PaymentReconciliationService {
  constructor(private readonly database: DatabaseService) {}

  async recordWebhook(
    input: PaymentWebhookRequest,
  ): Promise<PaymentReconciliationResponse> {
    const provider = requireText(input.provider, 'provider');
    const externalEventId = requireText(
      input.externalEventId,
      'externalEventId',
    );
    const organizationId = requireUuid(input.organizationId, 'organizationId');
    const payloadHash = hashStable(input.payload);
    verifySignature(input.signature, payloadHash);

    return this.database.withOrganizationScope(
      organizationId,
      async (database) => {
        const existing = await database.query<ReconciliationRow>(
          `
          SELECT id, status, true AS duplicate
            FROM opes.payment_reconciliation_events
           WHERE provider = $1
             AND external_event_id = $2
           LIMIT 1
        `,
          [provider, externalEventId],
        );
        const duplicate = existing.rows[0];
        if (duplicate !== undefined) {
          return mapRow(duplicate);
        }

        const executionId = input.payload.executionId;
        const transactionHash = input.payload.transactionHash;
        validateOptionalUuid(executionId, 'payload.executionId');
        validateOptionalTransactionHash(
          transactionHash,
          'payload.transactionHash',
        );

        const inserted = await database.query<ReconciliationRow>(
          `
          INSERT INTO opes.payment_reconciliation_events (
            organization_id,
            provider,
            external_event_id,
            execution_id,
            transaction_hash,
            payload_hash,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'RECORDED')
          RETURNING id, status, false AS duplicate
        `,
          [
            organizationId,
            provider,
            externalEventId,
            executionId ?? null,
            transactionHash?.toLowerCase() ?? null,
            payloadHash,
          ],
        );

        return mapRow(requireRow(inserted.rows[0]));
      },
    );
  }
}

function verifySignature(signature: string, payloadHash: string): void {
  const secret = process.env.OPES_PAYMENT_WEBHOOK_SECRET;
  if (secret === undefined || secret.trim() === '') {
    throw new BadRequestException('Payment webhook secret is not configured');
  }

  const expected = createHash('sha256')
    .update(`${payloadHash}:${secret}`)
    .digest('hex');
  const supplied = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
  if (!/^[0-9a-fA-F]{64}$/.test(supplied)) {
    throw new BadRequestException('Payment webhook signature is invalid');
  }

  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(supplied, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new BadRequestException('Payment webhook signature is invalid');
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

function validateOptionalUuid(value: string | undefined, name: string): void {
  if (value !== undefined) {
    requireUuid(value, name);
  }
}

function validateOptionalTransactionHash(
  value: string | undefined,
  name: string,
): void {
  if (value !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new BadRequestException(`${name} must be an EVM transaction hash`);
  }
}

function mapRow(row: ReconciliationRow): PaymentReconciliationResponse {
  return {
    id: row.id,
    duplicate: row.duplicate,
    status: row.status,
  };
}

function requireRow<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new Error('Expected reconciliation row');
  }
  return row;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
