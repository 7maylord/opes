import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildCctpReceiveMessageCalldata } from './cctp-calldata';
import { DatabaseService, TenantDatabase } from './database.service';
import { isEvmAddress } from './evm-decision-hash';
import { CircleWalletService } from './circle-wallet.service';

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
  sourceContract: string;
  destinationContract: string;
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
  messages?: Array<{
    status?: unknown;
    message?: unknown;
    attestation?: unknown;
  }>;
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

interface CctpAttestation {
  message: string;
  attestation: string;
}

interface GatewaySubmissionResponse {
  providerReference: string;
  transactionHash: string | null;
  attestation?: string;
  signature?: string;
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

  constructor(
    private readonly database: DatabaseService,
    private readonly circle: CircleWalletService,
  ) {}

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
                AND (
                      (status = 'PENDING' AND available_at <= now())
                   OR (status = 'PROCESSING' AND updated_at < now() - interval '5 minutes')
                    )
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
      if (
        action.action_type === 'CCTP_TRANSFER' &&
        typeof action.provider_payload.sourceBurnTransactionHash !== 'string'
      ) {
        await this.reconcileSourceBurn(event, action);
        return;
      }
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
        await submitGatewayTransfer(request, this.circle),
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
      if (
        typeof action.provider_payload.gatewayMintCircleTransactionId !==
        'string'
      ) {
        const transactionId = await submitGatewayMint(action, this.circle);
        await this.recordGatewayMintSubmitted(event, transactionId);
        return;
      }
      const response = await reconcileGatewayTransfer(
        buildGatewayStatusRequest(action),
        this.circle,
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

  private async recordGatewayMintSubmitted(
    event: OutboxEventRow,
    transactionId: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.liquidity_actions
            SET provider_payload = provider_payload || jsonb_build_object(
                  'gatewayMintCircleTransactionId', $3::text
                ), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, transactionId],
      );
      await markOutboxProcessed(database, event.id);
      await enqueueLiquidityAction(
        database,
        event.organization_id,
        event.aggregate_id,
        'liquidity.execute.gateway',
        15,
      );
    });
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
      const source = objectAt(action.provider_payload.source, 'source');
      const approvalId =
        action.provider_payload.cctpApprovalCircleTransactionId;
      if (typeof approvalId !== 'string') {
        const transaction = await this.circle.createContractTransaction({
          walletAddress: requireAddress(
            source.walletAddress,
            'source.walletAddress',
          ),
          blockchain: circleBlockchain(action.source_chain_id),
          contractAddress: requireAddress(source.usdc, 'source.usdc'),
          abiFunctionSignature: 'approve(address,uint256)',
          abiParameters: [request.to, action.amount_atomic],
          idempotencyKey: stableUuid(`${action.id}:cctp-approve`),
        });
        await this.recordCctpProviderStep(
          event,
          'cctpApprovalCircleTransactionId',
          transaction.id,
        );
        return;
      }
      if (
        typeof action.provider_payload.cctpApprovalTransactionHash !== 'string'
      ) {
        const hash = await circleTransactionHash(this.circle, approvalId);
        if (hash === null) {
          await markOutboxPendingLater(this.database, event.id, 15);
          return;
        }
        await this.recordCctpProviderStep(
          event,
          'cctpApprovalTransactionHash',
          hash,
        );
        return;
      }
      const transaction = await this.circle.createCallDataTransaction({
        walletId: requireText(source.walletId, 'source.walletId'),
        contractAddress: request.to,
        callData: request.data,
        idempotencyKey: stableUuid(`${action.id}:cctp-burn`),
      });
      await this.recordCctpBurnSubmitted(event, transaction.id);
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

  private async reconcileSourceBurn(
    event: OutboxEventRow,
    action: LiquidityWorkRow,
  ): Promise<void> {
    try {
      const transactionId = requireText(
        action.provider_payload.cctpBurnCircleTransactionId,
        'cctpBurnCircleTransactionId',
      );
      const hash = await circleTransactionHash(this.circle, transactionId);
      if (hash === null) {
        await markOutboxPendingLater(this.database, event.id, 15);
        return;
      }
      await this.recordCctpBurnConfirmed(event, hash);
    } catch (error) {
      await this.failLiquidityAction(
        event,
        error instanceof Error
          ? error.message
          : 'CCTP burn reconciliation failed',
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
      const transactionId = action.provider_payload.cctpMintCircleTransactionId;
      if (typeof transactionId !== 'string') {
        const destination = objectAt(
          action.provider_payload.destination,
          'destination',
        );
        const transaction = await this.circle.createCallDataTransaction({
          walletId: requireText(destination.walletId, 'destination.walletId'),
          contractAddress: request.to,
          callData: request.data,
          idempotencyKey: stableUuid(`${action.id}:cctp-mint`),
        });
        await this.recordCctpProviderStep(
          event,
          'cctpMintCircleTransactionId',
          transaction.id,
          15,
        );
        return;
      }
      const transactionHash = await circleTransactionHash(
        this.circle,
        transactionId,
      );
      if (transactionHash === null) {
        await markOutboxPendingLater(this.database, event.id, 15);
        return;
      }
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

  private async recordCctpProviderStep(
    event: OutboxEventRow,
    key: string,
    value: string,
    delaySeconds = 0,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.liquidity_actions
            SET provider_payload = provider_payload || jsonb_build_object($3::text, $4::text), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, key, value],
      );
      await markOutboxProcessed(database, event.id);
      await enqueueLiquidityAction(
        database,
        event.organization_id,
        event.aggregate_id,
        'liquidity.execute.cctp',
        delaySeconds,
      );
    });
  }

  private async recordCctpBurnSubmitted(
    event: OutboxEventRow,
    transactionId: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.liquidity_actions SET status = 'SUBMITTED', submitted_at = now(),
                provider_payload = provider_payload || jsonb_build_object('cctpBurnCircleTransactionId', $3::text), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, transactionId],
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

  private async recordCctpBurnConfirmed(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.liquidity_actions SET provider_reference = $3,
                provider_payload = provider_payload || jsonb_build_object('sourceBurnTransactionHash', $3::text), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
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
                     'destinationMintTransactionHash', $5::text,
                     'gatewayAttestation', $6::text,
                     'gatewaySignature', $7::text
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
          response.attestation,
          response.signature,
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
    attestation: CctpAttestation,
  ): Promise<LiquidityWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET status = 'ATTESTED',
                 provider_payload = provider_payload || jsonb_build_object(
                   'attestation', $3::text,
                   'attestedSourceMessage', $4::text
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
          attestation.attestation,
          attestation.message,
        ],
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

function buildSourceBurnRequest(
  action: LiquidityWorkRow,
): ContractSignerRequest {
  const request = (action.provider_payload as { signerRequest?: unknown })
    .signerRequest;
  if (request === null || typeof request !== 'object') {
    throw new Error('Liquidity action is missing signer request');
  }
  const value = request as Record<string, unknown>;
  const signerRequest: ContractSignerRequest = {
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

function buildDestinationMintRequest(
  action: LiquidityWorkRow,
): ContractSignerRequest {
  const payload = action.provider_payload;
  const destination = objectAt(payload.destination, 'destination');
  const sourceMessage = requireHex(
    payload.attestedSourceMessage,
    'attestedSourceMessage',
  );
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
    sourceContract: requireAddress(
      request.sourceContract,
      'gatewayRequest.sourceContract',
    ),
    destinationContract: requireAddress(
      request.destinationContract,
      'gatewayRequest.destinationContract',
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
      action.provider_payload.gatewayMintCircleTransactionId,
      'gatewayMintCircleTransactionId',
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

async function fetchAttestation(
  action: LiquidityWorkRow,
): Promise<CctpAttestation> {
  const sourceMessage = requireHex(
    action.provider_payload.sourceMessage,
    'sourceMessage',
  );
  const transactionHash = requireHex32(
    action.provider_payload.sourceBurnTransactionHash,
    'sourceBurnTransactionHash',
  );
  const sourceDomain = requireNumber(
    objectAt(action.provider_payload.source, 'source').domain,
    'source.domain',
  );
  const baseUrl = attestationBaseUrl(action.provider_payload);
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`,
  );
  if (response.status === 404) {
    throw new AttestationPendingError('CCTP attestation is pending');
  }
  if (!response.ok) {
    throw new Error(`CCTP attestation returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as AttestationResponse;
  const message = body.messages?.find(
    (item) =>
      typeof item.message === 'string' &&
      matchesCctpV2Template(sourceMessage, item.message),
  );
  if (message?.status !== 'complete') {
    throw new AttestationPendingError('CCTP attestation is pending');
  }
  return {
    message: requireHex(message.message, 'attested message'),
    attestation: requireHex(message.attestation, 'attestation'),
  };
}

function matchesCctpV2Template(template: string, canonical: string): boolean {
  const left = Buffer.from(
    requireHex(template, 'sourceMessage').slice(2),
    'hex',
  );
  const right = Buffer.from(
    requireHex(canonical, 'attested message').slice(2),
    'hex',
  );
  if (left.length !== right.length || left.length < 148) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((index >= 12 && index < 44) || (index >= 144 && index < 148)) continue;
    if (left[index] !== right[index]) return false;
  }
  return true;
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

async function submitGatewayTransfer(
  request: GatewaySignerRequest,
  circle: CircleWalletService,
): Promise<GatewaySubmissionResponse> {
  if (Date.parse(request.quoteExpiresAt) <= Date.now()) {
    throw new Error('Gateway quote has expired');
  }
  const burnIntent = {
    maxBlockHeight: ((1n << 256n) - 1n).toString(),
    maxFee: process.env.OPES_GATEWAY_MAX_FEE_ATOMIC?.trim() || '2010000',
    spec: {
      version: 1,
      sourceDomain: request.sourceDomain,
      destinationDomain: request.destinationDomain,
      sourceContract: addressToBytes32(request.sourceContract),
      destinationContract: addressToBytes32(request.destinationContract),
      sourceToken: addressToBytes32(request.sourceToken),
      destinationToken: addressToBytes32(request.destinationToken),
      sourceDepositor: addressToBytes32(request.sourceDepositor),
      destinationRecipient: addressToBytes32(request.destinationRecipient),
      sourceSigner: addressToBytes32(request.sourceDepositor),
      destinationCaller: addressToBytes32(
        '0x0000000000000000000000000000000000000000',
      ),
      value: request.amountAtomic,
      salt: `0x${createHash('sha256').update(request.idempotencyKey).digest('hex')}`,
      hookData: '0x',
    },
  };
  const typedData = JSON.stringify({
    types: GATEWAY_EIP712_TYPES,
    domain: { name: 'GatewayWallet', version: '1' },
    primaryType: 'BurnIntent',
    message: burnIntent,
  });
  const signature = await circle.signTypedData({
    walletAddress: request.sourceDepositor,
    blockchain: circleBlockchain(request.sourceChainId),
    data: typedData,
  });
  const response = await fetch(request.gatewayApiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ burnIntent, signature }]),
  });
  if (!response.ok)
    throw new Error(`Gateway API returned HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    providerReference: request.idempotencyKey,
    transactionHash: null,
    attestation: requireHex(body.attestation, 'Gateway attestation'),
    signature: requireHex(body.signature, 'Gateway signature'),
  };
}

async function submitGatewayMint(
  action: LiquidityWorkRow,
  circle: CircleWalletService,
): Promise<string> {
  const destination = objectAt(
    action.provider_payload.destination,
    'destination',
  );
  const transaction = await circle.createContractTransaction({
    walletAddress: requireAddress(
      destination.walletAddress,
      'destination.walletAddress',
    ),
    blockchain: circleBlockchain(action.destination_chain_id),
    contractAddress: requireAddress(
      destination.gatewayMinter,
      'destination.gatewayMinter',
    ),
    abiFunctionSignature: 'gatewayMint(bytes,bytes)',
    abiParameters: [
      requireHex(
        action.provider_payload.gatewayAttestation,
        'gatewayAttestation',
      ),
      requireHex(action.provider_payload.gatewaySignature, 'gatewaySignature'),
    ],
    idempotencyKey: stableUuid(`${action.id}:gateway-mint`),
  });
  return transaction.id;
}

async function reconcileGatewayTransfer(
  request: GatewayStatusRequest,
  circle: CircleWalletService,
): Promise<GatewaySubmissionResponse> {
  const transaction = await circle.getTransaction(request.transferId);
  if (!transaction.txHash) {
    if (['FAILED', 'CANCELLED', 'DENIED', 'STUCK'].includes(transaction.state))
      throw new Error(`Gateway mint failed (${transaction.state})`);
    return {
      providerReference: request.transferId,
      transactionHash: null,
    };
  }
  return {
    providerReference: request.transferId,
    transactionHash: requireHex32(transaction.txHash, 'Gateway mint hash'),
  };
}

async function circleTransactionHash(
  circle: CircleWalletService,
  transactionId: string,
): Promise<string | null> {
  const transaction = await circle.getTransaction(transactionId);
  if (transaction.txHash)
    return requireHex32(transaction.txHash, 'Circle transaction hash');
  if (['FAILED', 'CANCELLED', 'DENIED', 'STUCK'].includes(transaction.state))
    throw new Error(`Circle transaction failed (${transaction.state})`);
  return null;
}

const GATEWAY_EIP712_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ],
  TransferSpec: [
    ['version', 'uint32'],
    ['sourceDomain', 'uint32'],
    ['destinationDomain', 'uint32'],
    ['sourceContract', 'bytes32'],
    ['destinationContract', 'bytes32'],
    ['sourceToken', 'bytes32'],
    ['destinationToken', 'bytes32'],
    ['sourceDepositor', 'bytes32'],
    ['destinationRecipient', 'bytes32'],
    ['sourceSigner', 'bytes32'],
    ['destinationCaller', 'bytes32'],
    ['value', 'uint256'],
    ['salt', 'bytes32'],
    ['hookData', 'bytes'],
  ].map(([name, type]) => ({ name, type })),
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
};

function addressToBytes32(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function circleBlockchain(chainId: number): string {
  if (chainId === 5042002) return 'ARC-TESTNET';
  if (chainId === 84532) return 'BASE-SEPOLIA';
  if (chainId === 5042001) return 'ARC';
  if (chainId === 8453) return 'BASE';
  throw new Error(
    `Circle wallet blockchain is unsupported for chain ${chainId}`,
  );
}

function stableUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
