import { Injectable, Logger } from '@nestjs/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildCctpReceiveMessageCalldata } from './cctp-calldata';
import { DatabaseService, TenantDatabase } from './database.service';
import { isEvmAddress } from './evm-decision-hash';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
}

interface LiquidityWorkRow {
  id: string;
  organization_id: string;
  status: string;
  source_chain_id: number;
  destination_chain_id: number;
  provider_payload: Record<string, unknown>;
}

interface SignerRequest {
  provider: 'circle';
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: '0';
  idempotencyKey: string;
  liquidityActionId: string;
}

interface AttestationResponse {
  status?: unknown;
  attestation?: unknown;
}

interface JsonRpcResponse<T> {
  result?: T | null;
  error?: { message?: unknown };
}

interface TransactionReceipt {
  status?: unknown;
  logs?: unknown;
}

interface CctpSourceMessage {
  sourceMessage: string;
  sourceMessageHash: string;
}

class SignerUnavailableError extends Error {}
class UnknownSubmissionError extends Error {}
class SourceReceiptPendingError extends Error {}
class AttestationPendingError extends Error {}

@Injectable()
export class LiquidityExecutionWorkerService {
  private readonly logger = new Logger(LiquidityExecutionWorkerService.name);

  constructor(private readonly database: DatabaseService) {}

  async processDueLiquidityActions(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextLiquidityActionEvent();
      if (event === undefined) {
        return processed;
      }

      await this.processLiquidityAction(event);
      processed += 1;
    }

    return processed;
  }

  private async claimNextLiquidityActionEvent(): Promise<
    OutboxEventRow | undefined
  > {
    return this.database.withWorker(async (database) => {
      const result = await database.query<OutboxEventRow>(
        `
          UPDATE opes.outbox_events
             SET status = 'PROCESSING',
                 updated_at = now()
           WHERE id = (
             SELECT id
               FROM opes.outbox_events
              WHERE event_type = 'liquidity.execute.cctp'
                AND status = 'PENDING'
                AND available_at <= now()
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           RETURNING id, organization_id, aggregate_id
        `,
      );

      return result.rows[0];
    });
  }

  private async processLiquidityAction(event: OutboxEventRow): Promise<void> {
    const action = await this.prepareLiquidityAction(event);
    if (action === null) {
      return;
    }

    if (action.status === 'PLANNED') {
      await this.submitSourceBurn(event, action);
      return;
    }

    if (action.status === 'SUBMITTED') {
      await this.resolveSourceMessageAndMint(event, action);
      return;
    }

    if (action.status === 'ATTESTED') {
      await this.submitDestinationMint(event, action);
      return;
    }

    await markOutboxProcessed(this.database, event.id);
  }

  private async submitSourceBurn(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    let request: SignerRequest;
    try {
      request = buildSourceBurnRequest(action);
    } catch (error) {
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity action is invalid',
      );
      return;
    }

    try {
      const transactionHash = await submitSignerRequest(request);
      await this.recordSubmitted(event, transactionHash);
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknown(
          event,
          'Liquidity signer submission is unknown',
        );
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity signer failed',
      );
    }
  }

  private async attestAndMint(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      const attestation = await fetchAttestation(action);
      const refreshed = await this.recordAttested(event, attestation);
      await this.submitDestinationMint(event, refreshed);
    } catch (error) {
      if (error instanceof AttestationPendingError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'CCTP attestation failed',
      );
    }
  }

  private async resolveSourceMessageAndMint(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      const sourceMessage = hasSourceMessage(action)
        ? action
        : await this.recordSourceMessage(
            event,
            await fetchSourceMessage(action),
          );
      await this.attestAndMint(event, sourceMessage);
    } catch (error) {
      if (error instanceof SourceReceiptPendingError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'CCTP source receipt failed',
      );
    }
  }

  private async submitDestinationMint(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    let request: SignerRequest;
    try {
      request = buildDestinationMintRequest(action);
    } catch (error) {
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Destination mint is invalid',
      );
      return;
    }

    try {
      const transactionHash = await submitSignerRequest(request);
      await this.recordMinted(event, transactionHash);
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknown(
          event,
          'Destination mint submission is unknown',
        );
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Destination mint failed',
      );
    }
  }

  private async prepareLiquidityAction(
    event: OutboxEventRow,
  ): Promise<LiquidityWorkRow | null> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          SELECT
             id,
             organization_id,
             status,
             source_chain_id,
             destination_chain_id,
             provider_payload
           FROM opes.liquidity_actions
           WHERE organization_id = $1
             AND id = $2
             AND action_type = 'CCTP_TRANSFER'
             AND status IN ('PLANNED', 'SUBMITTED', 'ATTESTED')
           LIMIT 1
        `,
        [event.organization_id, event.aggregate_id],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return row;
      }

      await markOutboxProcessed(database, event.id);
      return null;
    });
  }

  private async recordSubmitted(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'SUBMITTED',
                 provider_reference = $3,
                 provider_payload = provider_payload || jsonb_build_object(
                   'sourceBurnTransactionHash', $3::text
                 ),
                 submitted_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, transactionHash],
      );
      await markOutboxProcessed(database, event.id);
      await enqueueLiquidityAction(
        database,
        event.organization_id,
        event.aggregate_id,
      );
    });
  }

  private async recordSourceMessage(
    event: OutboxEventRow,
    message: CctpSourceMessage,
  ): Promise<LiquidityWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET provider_payload = provider_payload || jsonb_build_object(
                   'sourceMessage', $3::text,
                   'sourceMessageHash', $4::text
                 ),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND action_type = 'CCTP_TRANSFER'
             AND status = 'SUBMITTED'
           RETURNING
             id,
             organization_id,
             status,
             source_chain_id,
             destination_chain_id,
             provider_payload
        `,
        [
          event.organization_id,
          event.aggregate_id,
          message.sourceMessage,
          message.sourceMessageHash,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Expected submitted liquidity action row');
      }
      return row;
    });
  }

  private async recordAttested(
    event: OutboxEventRow,
    attestation: string,
  ): Promise<LiquidityWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET status = 'ATTESTED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'attestation', $3::text
                 ),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
           RETURNING
             id,
             organization_id,
             status,
             source_chain_id,
             destination_chain_id,
             provider_payload
        `,
        [event.organization_id, event.aggregate_id, attestation],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Expected attested liquidity action row');
      }
      return row;
    });
  }

  private async recordMinted(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'MINTED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'destinationMintTransactionHash', $3::text
                 ),
                 confirmed_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, transactionHash],
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async recordUnknown(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'UNKNOWN',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, reason],
      );
      await markOutboxFailed(database, event.id, reason);
    });
  }

  private async failLiquidityAction(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'FAILED',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, reason],
      );
      await markOutboxFailed(database, event.id, reason);
    });

    this.logger.warn(`liquidity action job ${event.id} failed: ${reason}`);
  }
}

function buildSourceBurnRequest(action: LiquidityWorkRow): SignerRequest {
  const request = (action.provider_payload as { signerRequest?: unknown })
    .signerRequest;
  if (request === null || typeof request !== 'object') {
    throw new Error('Liquidity action is missing signer request');
  }
  const value = request as Record<string, unknown>;
  const signerRequest: SignerRequest = {
    provider: 'circle',
    chainId: requireNumber(value.chainId, 'signerRequest.chainId'),
    from: requireAddress(value.from, 'signerRequest.from'),
    to: requireAddress(value.to, 'signerRequest.to'),
    data: requireHex(value.data, 'signerRequest.data'),
    value: '0',
    idempotencyKey: action.id,
    liquidityActionId: action.id,
  };

  if (
    signerRequest.chainId !== action.source_chain_id ||
    value.provider !== 'circle' ||
    value.value !== '0' ||
    !signerRequest.data.startsWith('0x8e0250ee')
  ) {
    throw new Error('Liquidity signer request violates CCTP policy');
  }

  return signerRequest;
}

function buildDestinationMintRequest(action: LiquidityWorkRow): SignerRequest {
  const payload = action.provider_payload;
  const destination = objectAt(payload.destination, 'destination');
  const sourceMessage = requireHex(payload.sourceMessage, 'sourceMessage');
  const attestation = requireHex(payload.attestation, 'attestation');
  const messageTransmitter = requireAddress(
    destination.messageTransmitterV2,
    'destination.messageTransmitterV2',
  );
  const walletAddress = requireAddress(
    destination.walletAddress,
    'destination.walletAddress',
  );
  const data = buildCctpReceiveMessageCalldata({
    message: sourceMessage,
    attestation,
  });

  return {
    provider: 'circle',
    chainId: action.destination_chain_id,
    from: walletAddress,
    to: messageTransmitter,
    data,
    value: '0',
    idempotencyKey: `${action.id}:mint`,
    liquidityActionId: action.id,
  };
}

async function fetchSourceMessage(
  action: LiquidityWorkRow,
): Promise<CctpSourceMessage> {
  const transactionHash = requireHex32(
    action.provider_payload.sourceBurnTransactionHash,
    'sourceBurnTransactionHash',
  );
  const rpcUrl = sourceReceiptRpcUrl(action.provider_payload);
  const receipt = await fetchTransactionReceipt(rpcUrl, transactionHash);
  if (receipt === null) {
    throw new SourceReceiptPendingError('Source burn receipt is pending');
  }
  if (receipt.status !== '0x1') {
    throw new Error('Source burn transaction failed');
  }

  const sourceMessage = extractCctpMessage(receipt);
  return {
    sourceMessage,
    sourceMessageHash: hashHexBytes(sourceMessage),
  };
}

async function fetchTransactionReceipt(
  rpcUrl: string,
  transactionHash: string,
): Promise<TransactionReceipt | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [transactionHash],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SourceReceiptPendingError(
        `Source chain RPC returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as JsonRpcResponse<TransactionReceipt>;
    if (body.error !== undefined) {
      throw new Error(`Source chain RPC failed: ${errorMessage(body.error)}`);
    }
    return body.result ?? null;
  } catch (error) {
    if (error instanceof SourceReceiptPendingError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SourceReceiptPendingError('Source chain RPC timed out');
    }
    if (error instanceof TypeError) {
      throw new SourceReceiptPendingError('Source chain RPC is unavailable');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: { message?: unknown }): string {
  return typeof error.message === 'string' ? error.message : 'unknown';
}

function sourceReceiptRpcUrl(payload: Record<string, unknown>): string {
  const source = objectAt(payload.source, 'source');
  const environment = requireText(source.environment, 'source.environment');
  const envName = `OPES_RPC_${environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const url = process.env[envName]?.trim();
  if (url === undefined || url === '') {
    throw new SourceReceiptPendingError(`${envName} is not configured`);
  }
  return url;
}

function extractCctpMessage(receipt: TransactionReceipt): string {
  if (!Array.isArray(receipt.logs)) {
    throw new Error('Source burn receipt logs are invalid');
  }
  const topic = hashText('MessageSent(bytes)');
  for (const item of receipt.logs) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const log = item as { topics?: unknown; data?: unknown };
    if (!Array.isArray(log.topics)) {
      continue;
    }
    const topics = log.topics as unknown[];
    const firstTopic = topics[0];
    if (typeof firstTopic !== 'string' || firstTopic.toLowerCase() !== topic) {
      continue;
    }
    return decodeAbiBytes(requireHex(log.data, 'MessageSent.data'));
  }
  throw new SourceReceiptPendingError('CCTP MessageSent log is not available');
}

function decodeAbiBytes(value: string): string {
  const data = value.slice(2);
  if (data.length < 128) {
    throw new Error('MessageSent data is invalid');
  }
  const offset = Number.parseInt(data.slice(0, 64), 16);
  const length = Number.parseInt(data.slice(64, 128), 16);
  const start = offset * 2 + 64;
  const end = start + length * 2;
  if (offset !== 32 || !Number.isSafeInteger(length) || data.length < end) {
    throw new Error('MessageSent data is invalid');
  }
  return `0x${data.slice(start, end)}`.toLowerCase();
}

function hasSourceMessage(action: LiquidityWorkRow): boolean {
  return (
    typeof action.provider_payload.sourceMessage === 'string' &&
    typeof action.provider_payload.sourceMessageHash === 'string'
  );
}

async function fetchAttestation(action: LiquidityWorkRow): Promise<string> {
  const sourceMessageHash = requireHex(
    action.provider_payload.sourceMessageHash,
    'sourceMessageHash',
  );
  const baseUrl = attestationBaseUrl(action.provider_payload);
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/v1/attestations/${sourceMessageHash}`,
  );
  if (response.status === 404) {
    throw new AttestationPendingError('CCTP attestation is pending');
  }
  if (!response.ok) {
    throw new Error(`CCTP attestation returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as AttestationResponse;
  if (body.status !== 'complete') {
    throw new AttestationPendingError('CCTP attestation is pending');
  }
  return requireHex(body.attestation, 'attestation');
}

function attestationBaseUrl(payload: Record<string, unknown>): string {
  const configured = process.env.OPES_CCTP_ATTESTATION_URL?.trim();
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  const source = objectAt(payload.source, 'source');
  return source.tier === 'testnet'
    ? 'https://iris-api-sandbox.circle.com'
    : 'https://iris-api.circle.com';
}

async function submitSignerRequest(request: SignerRequest): Promise<string> {
  const url = process.env.OPES_PAYMENT_SIGNER_URL;
  if (url === undefined || url.trim() === '') {
    throw new SignerUnavailableError(
      'Payment signer adapter is not configured',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.OPES_PAYMENT_SIGNER_TOKEN === undefined
          ? {}
          : {
              authorization: `Bearer ${process.env.OPES_PAYMENT_SIGNER_TOKEN}`,
            }),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Payment signer returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { transactionHash?: unknown };
    if (
      typeof body.transactionHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
    ) {
      throw new Error('Payment signer returned an invalid transaction hash');
    }
    return body.transactionHash.toLowerCase();
  } catch (error) {
    if (error instanceof SignerUnavailableError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new UnknownSubmissionError('Payment signer request timed out');
    }
    if (error instanceof TypeError) {
      throw new UnknownSubmissionError('Payment signer submission is unknown');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function markOutboxProcessed(
  databaseOrService: TenantDatabase | DatabaseService,
  eventId: string,
): Promise<void> {
  const work = (database: TenantDatabase) =>
    database.query(
      `
        UPDATE opes.outbox_events
           SET status = 'PROCESSED',
               processed_at = now(),
               updated_at = now()
         WHERE id = $1
      `,
      [eventId],
    );
  if ('withWorker' in databaseOrService) {
    await databaseOrService.withWorker(work);
    return;
  }
  await work(databaseOrService);
}

async function markOutboxFailed(
  database: TenantDatabase,
  eventId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.outbox_events
         SET status = 'FAILED',
             payload = payload || jsonb_build_object('failureReason', $2::text),
             processed_at = now(),
             updated_at = now()
       WHERE id = $1
    `,
    [eventId, reason],
  );
}

async function enqueueLiquidityAction(
  database: TenantDatabase,
  organizationId: string,
  actionId: string,
): Promise<void> {
  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload,
        available_at
      )
      SELECT $1, 'liquidity.execute.cctp', 'liquidity_action', $2, '{}'::jsonb,
             now() + interval '15 seconds'
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = 'liquidity.execute.cctp'
           AND aggregate_type = 'liquidity_action'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, actionId],
  );
}

async function markOutboxPendingLater(
  database: DatabaseService,
  eventId: string,
  delaySeconds: number,
): Promise<void> {
  await database.withWorker((workerDatabase) =>
    workerDatabase.query(
      `
        UPDATE opes.outbox_events
           SET status = 'PENDING',
               available_at = now() + ($2::text || ' seconds')::interval,
               updated_at = now()
         WHERE id = $1
      `,
      [eventId, delaySeconds.toString()],
    ),
  );
}

function objectAt(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireAddress(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isEvmAddress(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireHex(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value.toLowerCase();
}

function requireHex32(value: unknown, name: string): string {
  const hex = requireHex(value, name);
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${name} is invalid`);
  }
  return hex;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function hashHexBytes(value: string): string {
  return `0x${Buffer.from(
    keccak_256(Buffer.from(value.slice(2), 'hex')),
  ).toString('hex')}`;
}

function hashText(value: string): string {
  return `0x${Buffer.from(keccak_256(Buffer.from(value))).toString('hex')}`;
}
