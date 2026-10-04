import { Injectable, Logger } from '@nestjs/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildCctpReceiveMessageCalldata } from './cctp-calldata';
import { DatabaseService, TenantDatabase } from './database.service';
import { isEvmAddress } from './evm-decision-hash';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
  event_type: string;
}

interface LiquidityWorkRow {
  id: string;
  organization_id: string;
  action_type: string;
  status: string;
  source_environment: string;
  source_chain_id: number;
  source_asset_symbol: string;
  destination_environment: string;
  destination_chain_id: number;
  destination_asset_symbol: string;
  amount_atomic: string;
  provider_payload: Record<string, unknown>;
}

interface ContractSignerRequest {
  provider: 'circle';
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: '0';
  idempotencyKey: string;
  liquidityActionId: string;
}

interface GatewaySignerRequest {
  provider: 'circle-gateway';
  action: 'transferUnifiedUsdc';
  sourceChainId: number;
  destinationChainId: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceDepositor: string;
  destinationRecipient: string;
  sourceToken: string;
  destinationToken: string;
  amountAtomic: string;
  quoteExpiresAt: string;
  gatewayApiUrl: string;
  destinationSwap?: unknown;
  idempotencyKey: string;
  liquidityActionId: string;
}

interface GatewayStatusRequest {
  provider: 'circle-gateway';
  action: 'getTransferStatus';
  transferId: string;
  destinationChainId: number;
  idempotencyKey: string;
  liquidityActionId: string;
}

interface SwapSignerRequest {
  provider: 'swap';
  action: 'swapExactInput';
  chainId: number;
  from: string;
  router: string;
  inputToken: string;
  outputToken: string;
  amountInAtomic: string;
  minimumOutputAtomic: string;
  idempotencyKey: string;
  liquidityActionId: string;
}

interface SwapStatusRequest {
  provider: 'swap';
  action: 'getSwapStatus';
  chainId: number;
  transactionHash: string;
  idempotencyKey: string;
  liquidityActionId: string;
}

type SignerRequest =
  | ContractSignerRequest
  | GatewaySignerRequest
  | GatewayStatusRequest
  | SwapSignerRequest
  | SwapStatusRequest;

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

interface GatewaySubmissionResponse {
  providerReference: string;
  transactionHash: string | null;
}

interface SwapSubmissionResponse {
  transactionHash: string;
  outputAmountAtomic: string | null;
}

interface SwapStatusResponse {
  complete: boolean;
  outputAmountAtomic: string | null;
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
              WHERE event_type IN (
                      'liquidity.execute.cctp',
                      'liquidity.execute.gateway'
                    )
                AND status = 'PENDING'
                AND available_at <= now()
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           RETURNING id, organization_id, aggregate_id, event_type
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

    if (
      action.action_type === 'GATEWAY_TRANSFER' &&
      action.status === 'PLANNED'
    ) {
      await this.processGatewayTransfer(event, action);
      return;
    }

    if (
      action.action_type === 'GATEWAY_TRANSFER' &&
      action.status === 'SUBMITTED'
    ) {
      await this.reconcileGatewayTransfer(event, action);
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

    if (action.status === 'MINTED') {
      await this.settleMintedLiquidity(event, action);
      return;
    }

    if (action.status === 'SWAP_SUBMITTED') {
      await this.reconcileDestinationSwap(event, action);
      return;
    }

    if (action.status === 'SWAPPED') {
      await this.confirmLiquiditySettlement(event, action);
      return;
    }

    await markOutboxProcessed(this.database, event.id);
  }

  private async processGatewayTransfer(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    if (action.status !== 'PLANNED') {
      await markOutboxProcessed(this.database, event.id);
      return;
    }

    let request: GatewaySignerRequest;
    try {
      request = buildGatewayTransferRequest(action);
    } catch (error) {
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Gateway action is invalid',
      );
      return;
    }

    try {
      await this.recordGatewaySubmitted(
        event,
        await submitGatewaySignerRequest(request),
      );
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknown(event, 'Gateway signer submission is unknown');
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Gateway signer failed',
      );
    }
  }

  private async reconcileGatewayTransfer(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      const response = await submitGatewayStatusRequest(
        buildGatewayStatusRequest(action),
      );
      if (response.transactionHash === null) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      const refreshed = await this.recordGatewayMinted(
        event,
        response.transactionHash,
      );
      await this.settleMintedLiquidity(event, refreshed);
    } catch (error) {
      if (error instanceof SourceReceiptPendingError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      if (error instanceof UnknownSubmissionError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error
          ? error.message
          : 'Gateway reconciliation failed',
      );
    }
  }

  private async settleMintedLiquidity(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      await assertDestinationTransactionSucceeded(action);
      if (hasDestinationSwap(action)) {
        const response = await submitSwapSignerRequest(
          buildDestinationSwapRequest(action),
        );
        if (response.outputAmountAtomic === null) {
          await this.recordSwapSubmitted(event, response.transactionHash);
          return;
        }
        const refreshed = await this.recordSwapped(
          event,
          response.transactionHash,
          response.outputAmountAtomic,
        );
        await this.confirmLiquiditySettlement(event, refreshed);
        return;
      }
      await this.confirmLiquiditySettlement(event, action);
    } catch (error) {
      if (error instanceof SourceReceiptPendingError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknown(event, 'Liquidity swap submission is unknown');
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity settlement failed',
      );
    }
  }

  private async reconcileDestinationSwap(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      const response = await submitSwapStatusRequest(
        buildSwapStatusRequest(action),
      );
      if (!response.complete || response.outputAmountAtomic === null) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      const refreshed = await this.recordSwapped(
        event,
        requireHex32(
          action.provider_payload.destinationSwapTransactionHash,
          'destinationSwapTransactionHash',
        ),
        response.outputAmountAtomic,
      );
      await this.confirmLiquiditySettlement(event, refreshed);
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await markOutboxPendingLater(this.database, event.id, 60);
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity swap failed',
      );
    }
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
             action_type,
             status,
             source_environment,
             source_chain_id,
             source_asset_symbol,
             destination_environment,
             destination_chain_id,
             destination_asset_symbol,
             amount_atomic::text AS amount_atomic,
             provider_payload
           FROM opes.liquidity_actions
           WHERE organization_id = $1
             AND id = $2
             AND (
                   ($3 = 'liquidity.execute.cctp' AND action_type = 'CCTP_TRANSFER')
                OR ($3 = 'liquidity.execute.gateway' AND action_type = 'GATEWAY_TRANSFER')
             )
             AND status IN (
               'PLANNED',
               'SUBMITTED',
               'ATTESTED',
               'MINTED',
               'SWAP_SUBMITTED',
               'SWAPPED'
             )
           LIMIT 1
        `,
        [event.organization_id, event.aggregate_id, event.event_type],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return row;
      }

      await markOutboxProcessed(database, event.id);
      return null;
    });
  }

  private async recordGatewaySubmitted(
    event: OutboxEventRow,
    response: GatewaySubmissionResponse,
  ): Promise<void> {
    const status = response.transactionHash === null ? 'SUBMITTED' : 'MINTED';
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = $3,
                 provider_reference = $4,
                 provider_payload = provider_payload || jsonb_strip_nulls(
                   jsonb_build_object(
                     'gatewayTransferReference', $4::text,
                     'destinationMintTransactionHash', $5::text
                   )
                 ),
                 submitted_at = COALESCE(submitted_at, now()),
                 confirmed_at = CASE WHEN $3 = 'MINTED' THEN now() ELSE confirmed_at END,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [
          event.organization_id,
          event.aggregate_id,
          status,
          response.providerReference,
          response.transactionHash,
        ],
      );
      await markOutboxProcessed(database, event.id);
      await enqueueLiquidityAction(
        database,
        event.organization_id,
        event.aggregate_id,
        'liquidity.execute.gateway',
        status === 'MINTED' ? 15 : 60,
      );
    });
  }

  private async recordGatewayMinted(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<LiquidityWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET status = 'MINTED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'destinationMintTransactionHash', $3::text
                 ),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
           RETURNING
             id,
             organization_id,
             action_type,
             status,
             source_environment,
             source_chain_id,
             source_asset_symbol,
             destination_environment,
             destination_chain_id,
             destination_asset_symbol,
             amount_atomic::text AS amount_atomic,
             provider_payload
        `,
        [event.organization_id, event.aggregate_id, transactionHash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Expected minted liquidity action row');
      }
      return row;
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
             action_type,
             status,
             source_environment,
             source_chain_id,
             source_asset_symbol,
             destination_environment,
             destination_chain_id,
             destination_asset_symbol,
             amount_atomic::text AS amount_atomic,
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
             action_type,
             status,
             source_environment,
             source_chain_id,
             source_asset_symbol,
             destination_environment,
             destination_chain_id,
             destination_asset_symbol,
             amount_atomic::text AS amount_atomic,
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
        'liquidity.execute.cctp',
        15,
      );
    });
  }

  private async recordSwapSubmitted(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'SWAP_SUBMITTED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'destinationSwapTransactionHash', $3::text
                 ),
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
        event.event_type,
        60,
      );
    });
  }

  private async recordSwapped(
    event: OutboxEventRow,
    transactionHash: string,
    outputAmountAtomic: string,
  ): Promise<LiquidityWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET status = 'SWAPPED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'destinationSwapTransactionHash', $3::text,
                   'destinationSwapOutputAmountAtomic', $4::text
                 ),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
           RETURNING
             id,
             organization_id,
             action_type,
             status,
             source_environment,
             source_chain_id,
             source_asset_symbol,
             destination_environment,
             destination_chain_id,
             destination_asset_symbol,
             amount_atomic::text AS amount_atomic,
             provider_payload
        `,
        [
          event.organization_id,
          event.aggregate_id,
          transactionHash,
          outputAmountAtomic,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Expected swapped liquidity action row');
      }
      return row;
    });
  }

  private async confirmLiquiditySettlement(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await insertLiquidityLedger(database, action);
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'CONFIRMED',
                 confirmed_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id],
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

function buildGatewayTransferRequest(
  action: LiquidityWorkRow,
): GatewaySignerRequest {
  const request = objectAt(
    action.provider_payload.gatewayRequest,
    'gatewayRequest',
  );
  const sourceDomain = requireNumber(
    request.sourceDomain,
    'gatewayRequest.sourceDomain',
  );
  const destinationDomain = requireNumber(
    request.destinationDomain,
    'gatewayRequest.destinationDomain',
  );
  const gatewayRequest: GatewaySignerRequest = {
    provider: 'circle-gateway',
    action: 'transferUnifiedUsdc',
    sourceChainId: requireNumber(
      request.sourceChainId,
      'gatewayRequest.sourceChainId',
    ),
    destinationChainId: requireNumber(
      request.destinationChainId,
      'gatewayRequest.destinationChainId',
    ),
    sourceDomain,
    destinationDomain,
    sourceDepositor: requireAddress(
      request.sourceDepositor,
      'gatewayRequest.sourceDepositor',
    ),
    destinationRecipient: requireAddress(
      request.destinationRecipient,
      'gatewayRequest.destinationRecipient',
    ),
    sourceToken: requireAddress(
      request.sourceToken,
      'gatewayRequest.sourceToken',
    ),
    destinationToken: requireAddress(
      request.destinationToken,
      'gatewayRequest.destinationToken',
    ),
    amountAtomic: requireIntegerString(
      request.amountAtomic,
      'gatewayRequest.amountAtomic',
    ),
    quoteExpiresAt: requireIsoTimestamp(
      request.quoteExpiresAt,
      'gatewayRequest.quoteExpiresAt',
    ),
    gatewayApiUrl: requireUrl(
      request.gatewayApiUrl,
      'gatewayRequest.gatewayApiUrl',
    ),
    idempotencyKey: action.id,
    liquidityActionId: action.id,
  };
  if (
    request.destinationSwap !== undefined &&
    request.destinationSwap !== null
  ) {
    gatewayRequest.destinationSwap = request.destinationSwap;
  }
  if (
    gatewayRequest.sourceChainId !== action.source_chain_id ||
    gatewayRequest.destinationChainId !== action.destination_chain_id
  ) {
    throw new Error('Gateway signer request violates route policy');
  }
  return gatewayRequest;
}

function buildGatewayStatusRequest(
  action: LiquidityWorkRow,
): GatewayStatusRequest {
  return {
    provider: 'circle-gateway',
    action: 'getTransferStatus',
    transferId: requireText(
      action.provider_payload.gatewayTransferReference,
      'gatewayTransferReference',
    ),
    destinationChainId: action.destination_chain_id,
    idempotencyKey: `${action.id}:gateway-status`,
    liquidityActionId: action.id,
  };
}

function buildDestinationSwapRequest(
  action: LiquidityWorkRow,
): SwapSignerRequest {
  const destination = objectAt(
    action.provider_payload.destination,
    'destination',
  );
  const swap = objectAt(
    action.provider_payload.destinationSwap,
    'destinationSwap',
  );
  return {
    provider: 'swap',
    action: 'swapExactInput',
    chainId: action.destination_chain_id,
    from: requireAddress(
      destination.walletAddress,
      'destination.walletAddress',
    ),
    router: requireAddress(swap.router, 'destinationSwap.router'),
    inputToken: requireAddress(swap.inputToken, 'destinationSwap.inputToken'),
    outputToken: requireAddress(
      swap.outputToken,
      'destinationSwap.outputToken',
    ),
    amountInAtomic: requireIntegerString(
      swap.inputAmountAtomic,
      'destinationSwap.inputAmountAtomic',
    ),
    minimumOutputAtomic: requireIntegerString(
      swap.minimumOutputAtomic,
      'destinationSwap.minimumOutputAtomic',
    ),
    idempotencyKey: `${action.id}:swap`,
    liquidityActionId: action.id,
  };
}

function buildSwapStatusRequest(action: LiquidityWorkRow): SwapStatusRequest {
  return {
    provider: 'swap',
    action: 'getSwapStatus',
    chainId: action.destination_chain_id,
    transactionHash: requireHex32(
      action.provider_payload.destinationSwapTransactionHash,
      'destinationSwapTransactionHash',
    ),
    idempotencyKey: `${action.id}:swap-status`,
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
  return routeRpcUrl(payload, 'source');
}

function routeRpcUrl(
  payload: Record<string, unknown>,
  routePoint: 'source' | 'destination',
): string {
  const point = objectAt(payload[routePoint], routePoint);
  const environment = requireText(
    point.environment,
    `${routePoint}.environment`,
  );
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

function hasDestinationSwap(action: LiquidityWorkRow): boolean {
  return (
    action.provider_payload.destinationSwap !== null &&
    typeof action.provider_payload.destinationSwap === 'object'
  );
}

async function assertDestinationTransactionSucceeded(
  action: LiquidityWorkRow,
): Promise<void> {
  const transactionHash = requireHex32(
    action.provider_payload.destinationMintTransactionHash,
    'destinationMintTransactionHash',
  );
  const receipt = await fetchTransactionReceipt(
    routeRpcUrl(action.provider_payload, 'destination'),
    transactionHash,
  );
  if (receipt === null) {
    throw new SourceReceiptPendingError('Destination mint receipt is pending');
  }
  if (receipt.status !== '0x1') {
    throw new Error('Destination mint transaction failed');
  }
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
  const body = await submitSignerRequestBody(request);
  if (
    typeof body.transactionHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
  ) {
    throw new Error('Payment signer returned an invalid transaction hash');
  }
  return body.transactionHash.toLowerCase();
}

async function submitGatewaySignerRequest(
  request: GatewaySignerRequest,
): Promise<GatewaySubmissionResponse> {
  const body = await submitSignerRequestBody(request);
  const providerReference =
    typeof body.providerReference === 'string'
      ? body.providerReference
      : typeof body.transferId === 'string'
        ? body.transferId
        : typeof body.transactionHash === 'string'
          ? body.transactionHash
          : null;
  if (providerReference === null || providerReference.trim() === '') {
    throw new Error('Payment signer returned an invalid Gateway reference');
  }
  const transactionHash =
    typeof body.transactionHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
      ? body.transactionHash.toLowerCase()
      : null;
  return {
    providerReference,
    transactionHash,
  };
}

async function submitGatewayStatusRequest(
  request: GatewayStatusRequest,
): Promise<GatewaySubmissionResponse> {
  const body = await submitSignerRequestBody(request);
  const pending =
    typeof body.status === 'string' &&
    ['pending', 'submitted', 'processing'].includes(body.status.toLowerCase());
  if (pending) {
    return {
      providerReference: request.transferId,
      transactionHash: null,
    };
  }
  const transactionHash =
    typeof body.transactionHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
      ? body.transactionHash.toLowerCase()
      : null;
  if (transactionHash === null) {
    throw new UnknownSubmissionError('Gateway transfer status is unknown');
  }
  return {
    providerReference: request.transferId,
    transactionHash,
  };
}

async function submitSwapSignerRequest(
  request: SwapSignerRequest,
): Promise<SwapSubmissionResponse> {
  const body = await submitSignerRequestBody(request);
  const transactionHash =
    typeof body.transactionHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
      ? body.transactionHash.toLowerCase()
      : null;
  if (transactionHash === null) {
    throw new Error('Payment signer returned an invalid swap transaction hash');
  }
  return {
    transactionHash,
    outputAmountAtomic:
      body.outputAmountAtomic === undefined
        ? null
        : requireIntegerString(body.outputAmountAtomic, 'outputAmountAtomic'),
  };
}

async function submitSwapStatusRequest(
  request: SwapStatusRequest,
): Promise<SwapStatusResponse> {
  const body = await submitSignerRequestBody(request);
  const complete =
    typeof body.status === 'string' &&
    ['complete', 'confirmed', 'success'].includes(body.status.toLowerCase());
  if (!complete) {
    return { complete: false, outputAmountAtomic: null };
  }
  return {
    complete: true,
    outputAmountAtomic: requireIntegerString(
      body.outputAmountAtomic,
      'outputAmountAtomic',
    ),
  };
}

async function submitSignerRequestBody(
  request: SignerRequest,
): Promise<Record<string, unknown>> {
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

    return (await response.json()) as Record<string, unknown>;
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

async function insertLiquidityLedger(
  database: TenantDatabase,
  action: LiquidityWorkRow,
): Promise<void> {
  const destinationMintHash = requireHex32(
    action.provider_payload.destinationMintTransactionHash,
    'destinationMintTransactionHash',
  );
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
        ($1, 'LIQUIDITY_SETTLED', $2, 1, $3, 'DEBIT', 'USDC', $5, 'LIQUIDITY_ACTION', $2, NULL, NULL, $6),
        ($1, 'LIQUIDITY_SETTLED', $2, 2, $4, 'CREDIT', 'USDC', $5, 'LIQUIDITY_ACTION', $2, NULL, NULL, $6)
      ON CONFLICT (organization_id, ledger_event_type, ledger_event_id, line_number)
      DO UPDATE SET metadata = opes.ledger_entries.metadata
    `,
    [
      action.organization_id,
      action.id,
      liquidityAssetAccount(action.destination_environment, 'USDC'),
      liquidityAssetAccount(action.source_environment, 'USDC'),
      action.amount_atomic,
      destinationMintHash,
    ],
  );

  if (!hasDestinationSwap(action)) {
    return;
  }

  const outputAmount = requireIntegerString(
    action.provider_payload.destinationSwapOutputAmountAtomic,
    'destinationSwapOutputAmountAtomic',
  );
  const minimumOutput = requireIntegerString(
    objectAt(action.provider_payload.destinationSwap, 'destinationSwap')
      .minimumOutputAtomic,
    'destinationSwap.minimumOutputAtomic',
  );
  if (BigInt(outputAmount) < BigInt(minimumOutput)) {
    throw new Error('Destination swap output is below the authorized minimum');
  }
  const swapHash = requireHex32(
    action.provider_payload.destinationSwapTransactionHash,
    'destinationSwapTransactionHash',
  );
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
        ($1, 'LIQUIDITY_SWAP_SETTLED', $2, 1, $3, 'CREDIT', 'USDC', $5, 'LIQUIDITY_ACTION', $2, NULL, NULL, $7),
        ($1, 'LIQUIDITY_SWAP_SETTLED', $2, 2, 'CLEARING:LIQUIDITY_SWAP_USDC', 'DEBIT', 'USDC', $5, 'LIQUIDITY_ACTION', $2, NULL, NULL, $7),
        ($1, 'LIQUIDITY_SWAP_SETTLED', $2, 3, $4, 'DEBIT', 'USDT', $6, 'LIQUIDITY_ACTION', $2, NULL, NULL, $7),
        ($1, 'LIQUIDITY_SWAP_SETTLED', $2, 4, 'CLEARING:LIQUIDITY_SWAP_USDT', 'CREDIT', 'USDT', $6, 'LIQUIDITY_ACTION', $2, NULL, NULL, $7)
      ON CONFLICT (organization_id, ledger_event_type, ledger_event_id, line_number)
      DO UPDATE SET metadata = opes.ledger_entries.metadata
    `,
    [
      action.organization_id,
      action.id,
      liquidityAssetAccount(action.destination_environment, 'USDC'),
      liquidityAssetAccount(action.destination_environment, 'USDT'),
      action.amount_atomic,
      outputAmount,
      swapHash,
    ],
  );
}

function liquidityAssetAccount(environment: string, asset: string): string {
  return `ASSET:${environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}:${asset}`;
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
  eventType = 'liquidity.execute.cctp',
  delaySeconds = 15,
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
      SELECT $1, $3, 'liquidity_action', $2, '{}'::jsonb,
             now() + ($4::text || ' seconds')::interval
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = $3
           AND aggregate_type = 'liquidity_action'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, actionId, eventType, delaySeconds.toString()],
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

function requireIntegerString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${name} is invalid`);
  }
  return new Date(value).toISOString();
}

function requireUrl(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} is invalid`);
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} is invalid`);
  }
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
