import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from 'viem';
import vaultAbiJson from './abi/BusinessPolicyVault.json';
import { CircleWalletService } from './circle-wallet.service';
import { DatabaseService, TenantDatabase } from './database.service';
import { organizationDomain } from './evm-decision-hash';
import { FactoryManifestService } from './factory-manifest.service';
import { recordNotification } from './notification.service';
import {
  CircleLifecycleTransaction,
  LifecycleExecutionEvidence,
  LifecycleRpcReceipt,
  LifecycleRpcTransaction,
  TERMINAL_CIRCLE_STATES,
  verifyLifecycleExecution,
} from './lifecycle-chain-evidence';
import { addPeriod, dueAtUtc } from './lifecycle.service';
import { TenantContext } from './tenant-context';

const vaultAbi = vaultAbiJson as Parameters<
  typeof encodeFunctionData
>[0]['abi'];
const ARC_CHAIN_ID = 5_042_002;

export interface ChainActionResponse {
  id: string;
  actionType: string;
  actor: 'OWNER' | 'OPERATOR';
  to: string;
  data: string;
  chainId: number;
  status: string;
}

interface SubscriptionSetupRow {
  id: string;
  status: string;
  cadence: string;
  timezone: string;
  anchor_date: string;
  amount_atomic: string;
  payout_address: string;
  vault_address: string;
}

export interface ActionRow {
  id: string;
  organization_id: string;
  action_type: string;
  target_id: string;
  actor: 'OWNER' | 'OPERATOR';
  contract_address: string;
  call_data: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: string;
  provider_transaction_id: string | null;
}

@Injectable()
export class RecurringExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly circle: CircleWalletService,
    private readonly manifests: FactoryManifestService,
  ) {}

  async subscriptionOwnerActions(
    context: TenantContext,
    subscriptionId: string,
  ): Promise<ChainActionResponse[]> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Subscription activation requires the owner');
    return this.database.withTenant(context, async (database) => {
      const result = await database.query<ActionRow>(
        `SELECT * FROM opes.lifecycle_chain_actions
          WHERE organization_id=$1 AND target_type='subscription' AND target_id=$2
            AND actor='OWNER' AND action_type='CREATE_RECURRING_MANDATE'`,
        [context.organizationId, subscriptionId],
      );
      return result.rows.map(mapAction);
    });
  }

  async prepare(
    context: TenantContext,
    subscriptionId: string,
  ): Promise<ChainActionResponse[]> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Subscription activation requires the owner');
    return this.database.withTenant(context, async (database) => {
      const setup = await database.query<SubscriptionSetupRow>(
        `SELECT subscription.id, subscription.status, version.cadence, version.timezone,
                version.anchor_date::text AS anchor_date, version.amount_atomic::text AS amount_atomic,
                address.payout_address, vault.address AS vault_address
           FROM opes.subscriptions subscription
           JOIN opes.subscription_versions version ON version.organization_id = subscription.organization_id
            AND version.subscription_id = subscription.id AND version.status = 'ACTIVE'
           JOIN opes.vendor_payout_addresses address ON address.organization_id = subscription.organization_id
            AND address.id = subscription.vendor_address_id AND address.status = 'VERIFIED_ACTIVE'
           JOIN opes.tenant_resource_bindings vault ON vault.organization_id = subscription.organization_id
            AND vault.environment = 'arc-testnet' AND vault.resource_type = 'business_policy_vault_contract'
            AND vault.status = 'ACTIVE'
          WHERE subscription.organization_id = $1 AND subscription.id = $2 LIMIT 1`,
        [context.organizationId, subscriptionId],
      );
      const row = setup.rows[0];
      if (!row) throw new NotFoundException('Subscription setup is incomplete');
      if (!['ACTIVE', 'SETUP_REQUIRED'].includes(row.status))
        throw new ConflictException('Subscription cannot be activated');

      const mandateId = keccak256(
        stringToHex(`opes:subscription:${subscriptionId}`),
      );
      const schedule = buildSchedule(
        row.anchor_date,
        row.cadence,
        row.timezone,
      );
      const obligationKeys = schedule.map((_, index) =>
        keccak256(
          stringToHex(`opes:subscription-cycle:${subscriptionId}:${index}`),
        ),
      );
      for (const [index, cycle] of schedule.entries()) {
        await database.query(
          `INSERT INTO opes.subscription_cycles (
             organization_id, subscription_id, subscription_version_id,
             service_period_start, service_period_end, due_at, amount_atomic, cycle_index
           ) SELECT $1, $2, version.id, $3, $4, $5, version.amount_atomic, $6
               FROM opes.subscription_versions version
              WHERE version.organization_id = $1 AND version.subscription_id = $2 AND version.status = 'ACTIVE'
           ON CONFLICT (organization_id, subscription_id, service_period_start, service_period_end)
           DO UPDATE SET cycle_index = EXCLUDED.cycle_index`,
          [
            context.organizationId,
            subscriptionId,
            cycle.start,
            cycle.end,
            cycle.dueAt,
            index,
          ],
        );
      }
      await database.query(
        `UPDATE opes.subscriptions SET status = 'SETUP_REQUIRED', mandate_id = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, subscriptionId, mandateId],
      );
      const total = BigInt(row.amount_atomic) * BigInt(schedule.length);
      const actions = [
        [
          'CREATE_RECURRING_MANDATE',
          encodeFunctionData({
            abi: vaultAbi,
            functionName: 'createRecurringMandate',
            args: [
              mandateId,
              row.payout_address as `0x${string}`,
              BigInt(row.amount_atomic),
              schedule.map((item) =>
                BigInt(Math.floor(item.dueAt.getTime() / 1000)),
              ),
              obligationKeys,
              BigInt(Math.floor(schedule[0].dueAt.getTime() / 1000)),
              BigInt(Math.floor(schedule.at(-1)!.endAt.getTime() / 1000)),
              total,
            ],
          }),
        ],
      ] as const;
      const result: ChainActionResponse[] = [];
      for (const [actionType, data] of actions) {
        const action = await insertAction(
          database,
          context.organizationId,
          actionType,
          'subscription',
          subscriptionId,
          'OWNER',
          row.vault_address,
          data,
          { mandateId },
        );
        result.push(mapAction(action));
      }
      return result;
    });
  }

  async confirmOwnerAction(
    context: TenantContext,
    actionId: string,
    transactionHash: string,
  ): Promise<ChainActionResponse> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Only the owner can confirm this action');
    const action = await this.database.withTenant(context, async (database) => {
      const result = await database.query<
        ActionRow & { owner_address: string }
      >(
        `SELECT action.*, app_user.owner_wallet_address AS owner_address
           FROM opes.lifecycle_chain_actions action
           JOIN opes.organization_memberships membership ON membership.organization_id = action.organization_id
            AND membership.role = 'OWNER' AND membership.status = 'ACTIVE'
           JOIN opes.app_users app_user ON app_user.id = membership.user_id
          WHERE action.organization_id = $1 AND action.id = $2 AND action.actor = 'OWNER' LIMIT 1`,
        [context.organizationId, actionId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Owner action not found');
      await verifyOwnerTransaction(row, transactionHash);
      await database.query(
        `UPDATE opes.lifecycle_chain_actions SET status = 'CONFIRMED', transaction_hash = $3,
           submitted_at = COALESCE(submitted_at, now()), confirmed_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, actionId, transactionHash.toLowerCase()],
      );
      if (
        row.action_type === 'PAUSE_VAULT' ||
        row.action_type === 'RESUME_VAULT'
      ) {
        const lifecycleStatus =
          row.action_type === 'PAUSE_VAULT' ? 'PAUSED' : 'ACTIVE';
        await database.query(
          `WITH organization_update AS (
             UPDATE opes.organizations
                SET lifecycle_status = $2, updated_at = now()
              WHERE id = $1
              RETURNING id
           )
           UPDATE opes.business_agents
              SET lifecycle_status = $2, updated_at = now()
            WHERE organization_id = $1 AND is_primary = true`,
          [context.organizationId, lifecycleStatus],
        );
      }
      if (row.action_type === 'CREATE_RECURRING_MANDATE') {
        await database.query(
          `UPDATE opes.subscriptions SET status = 'ACTIVE', transaction_hash = $3, updated_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [
            context.organizationId,
            row.target_id,
            transactionHash.toLowerCase(),
          ],
        );
      } else if (
        [
          'PAUSE_RECURRING_MANDATE',
          'RESUME_RECURRING_MANDATE',
          'CANCEL_RECURRING_MANDATE',
        ].includes(row.action_type)
      ) {
        const status =
          row.action_type === 'PAUSE_RECURRING_MANDATE'
            ? 'PAUSED'
            : row.action_type === 'RESUME_RECURRING_MANDATE'
              ? 'ACTIVE'
              : 'CANCELLED';
        await database.query(
          `UPDATE opes.subscriptions SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2`,
          [context.organizationId, row.target_id, status],
        );
        if (status === 'CANCELLED')
          await database.query(
            `UPDATE opes.subscription_cycles SET status = 'CANCELLED'
            WHERE organization_id = $1 AND subscription_id = $2 AND status = 'DUE'`,
            [context.organizationId, row.target_id],
          );
      }
      const notification = recurringActionNotification(row.action_type);
      if (notification)
        await recordNotification(database, {
          organizationId: context.organizationId,
          type: notification.type,
          priority: notification.priority,
          title: notification.title,
          body: notification.body,
          subjectType: 'subscription',
          subjectId: row.target_id,
          actionView: 'agreements',
          dedupeKey: `recurring-action:${actionId}`,
          metadata: { transactionHash: transactionHash.toLowerCase() },
        });
      return { ...row, status: 'CONFIRMED' };
    });
    return mapAction(action);
  }

  async prepareStatusChange(
    context: TenantContext,
    subscriptionId: string,
    operation: 'pause' | 'resume' | 'cancel',
  ) {
    if (context.role !== 'OWNER')
      throw new ConflictException('Only the owner can change a mandate');
    return this.database.withTenant(context, async (database) => {
      const result = await database.query<{
        mandate_id: string;
        vault_address: string;
      }>(
        `SELECT subscription.mandate_id, vault.address AS vault_address FROM opes.subscriptions subscription
           JOIN opes.tenant_resource_bindings vault ON vault.organization_id = subscription.organization_id
            AND vault.environment = 'arc-testnet' AND vault.resource_type = 'business_policy_vault_contract' AND vault.status = 'ACTIVE'
          WHERE subscription.organization_id = $1 AND subscription.id = $2 AND subscription.mandate_id IS NOT NULL`,
        [context.organizationId, subscriptionId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Active mandate not found');
      const names = {
        pause: 'pauseRecurringMandate',
        resume: 'resumeRecurringMandate',
        cancel: 'cancelRecurringMandate',
      } as const;
      const types = {
        pause: 'PAUSE_RECURRING_MANDATE',
        resume: 'RESUME_RECURRING_MANDATE',
        cancel: 'CANCEL_RECURRING_MANDATE',
      } as const;
      return mapAction(
        await insertAction(
          database,
          context.organizationId,
          types[operation],
          'subscription',
          subscriptionId,
          'OWNER',
          row.vault_address,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: names[operation],
            args: [row.mandate_id as `0x${string}`],
          }),
          {},
        ),
      );
    });
  }

  async processDue(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const action = await this.nextRecurringAction();
      if (!action) break;
      await this.execute(action);
      processed += 1;
    }
    return processed;
  }

  private async nextRecurringAction(): Promise<ActionRow | undefined> {
    const pending = await this.database.withWorker((database) =>
      database.query<ActionRow>(
        `SELECT * FROM opes.lifecycle_chain_actions
          WHERE actor = 'OPERATOR' AND action_type = 'EXECUTE_RECURRING_PAYMENT'
            AND status IN ('PREPARED', 'SUBMITTED')
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      ),
    );
    return pending.rows[0] ?? this.prepareNextDueCycle();
  }

  private async prepareNextDueCycle(): Promise<ActionRow | undefined> {
    return this.database.withWorker(async (database) => {
      const due = await database.query<{
        id: string;
        organization_id: string;
        subscription_id: string;
        cycle_index: number;
        amount_atomic: string;
        due_at: Date;
        mandate_id: string;
        payout_address: string;
        vault_address: string;
        wallet_id: string;
        token_address: string;
      }>(
        `SELECT cycle.id, cycle.organization_id, cycle.subscription_id, cycle.cycle_index,
                cycle.amount_atomic::text AS amount_atomic, cycle.due_at, subscription.mandate_id,
                address.payout_address, vault.address AS vault_address, wallet.resource_id AS wallet_id,
                $1::text AS token_address
           FROM opes.subscription_cycles cycle
           JOIN opes.subscriptions subscription ON subscription.organization_id = cycle.organization_id
            AND subscription.id = cycle.subscription_id AND subscription.status = 'ACTIVE'
           JOIN opes.vendor_payout_addresses address ON address.organization_id = subscription.organization_id
            AND address.id = subscription.vendor_address_id AND address.status = 'VERIFIED_ACTIVE'
           JOIN opes.tenant_resource_bindings vault ON vault.organization_id = cycle.organization_id
            AND vault.environment = 'arc-testnet' AND vault.resource_type = 'business_policy_vault_contract' AND vault.status = 'ACTIVE'
           JOIN opes.tenant_resource_bindings wallet ON wallet.organization_id = cycle.organization_id
            AND wallet.environment = 'arc-testnet' AND wallet.resource_type = 'operator_wallet' AND wallet.status = 'ACTIVE'
          WHERE cycle.status = 'DUE' AND cycle.due_at <= now() AND cycle.cycle_index IS NOT NULL
          ORDER BY cycle.due_at FOR UPDATE OF cycle SKIP LOCKED LIMIT 1`,
        [this.manifests.getArcTestnetFactory().tokenAddress],
      );
      const row = due.rows[0];
      if (!row) return undefined;
      const obligationKey = keccak256(
        stringToHex(
          `opes:subscription-cycle:${row.subscription_id}:${row.cycle_index}`,
        ),
      );
      const contextHash = keccak256(stringToHex(`opes:recurring:${row.id}`));
      const expiresAt = Math.floor(row.due_at.getTime() / 1000) + 86_400;
      const decisionHash = recurringDecisionHash({
        organizationId: row.organization_id,
        vault: row.vault_address,
        token: row.token_address,
        mandateId: row.mandate_id,
        cycleIndex: row.cycle_index,
        obligationKey,
        contextHash,
        vendor: row.payout_address,
        amount: row.amount_atomic,
        expiresAt,
      });
      const data = encodeFunctionData({
        abi: vaultAbi,
        functionName: 'executeRecurringPayment',
        args: [
          row.mandate_id as `0x${string}`,
          row.cycle_index,
          decisionHash,
          obligationKey,
          contextHash,
          BigInt(row.amount_atomic),
          BigInt(expiresAt),
        ],
      });
      const action = await insertAction(
        database,
        row.organization_id,
        'EXECUTE_RECURRING_PAYMENT',
        'subscription_cycle',
        row.id,
        'OPERATOR',
        row.vault_address,
        data,
        {
          walletId: row.wallet_id,
          amountAtomic: row.amount_atomic,
          subscriptionId: row.subscription_id,
        },
      );
      await database.query(
        `UPDATE opes.subscription_cycles SET status = 'PROCESSING' WHERE organization_id = $1 AND id = $2 AND status = 'DUE'`,
        [row.organization_id, row.id],
      );
      return action;
    });
  }

  private async execute(action: ActionRow): Promise<void> {
    try {
      const evidence = await this.recurringEvidence(action);
      let providerId = action.provider_transaction_id;
      if (!providerId) {
        const submitted = await this.circle.createCallDataTransaction({
          walletId: evidence.walletId,
          contractAddress: evidence.contractAddress,
          callData: action.call_data,
          idempotencyKey: action.idempotency_key,
        });
        providerId = submitted.id;
        await this.database.withWorker((db) =>
          db.query(
            `UPDATE opes.lifecycle_chain_actions SET status = 'SUBMITTED', provider_transaction_id = $2, submitted_at = now(), updated_at = now() WHERE id = $1`,
            [action.id, providerId],
          ),
        );
      }
      const transaction = (await this.circle.getTransaction(
        providerId,
      )) as CircleLifecycleTransaction;
      if (TERMINAL_CIRCLE_STATES.has(transaction.state))
        throw new Error(
          transaction.errorDetails ??
            transaction.errorReason ??
            `Circle transaction ${transaction.state}`,
        );
      if (!transaction.txHash) return;
      const [chainTransaction, receipt] = await Promise.all([
        rpc<LifecycleRpcTransaction | null>('eth_getTransactionByHash', [
          transaction.txHash,
        ]),
        rpc<LifecycleRpcReceipt | null>('eth_getTransactionReceipt', [
          transaction.txHash,
        ]),
      ]);
      if (!receipt || !chainTransaction) return;
      const transactionHash = verifyLifecycleExecution(
        evidence,
        transaction,
        chainTransaction,
        receipt,
      );
      await this.database.withWorker(async (db) => {
        await db.query(
          `UPDATE opes.lifecycle_chain_actions SET status = 'CONFIRMED', transaction_hash = $2, confirmed_at = now(), updated_at = now() WHERE id = $1`,
          [action.id, transactionHash],
        );
        await db.query(
          `UPDATE opes.subscription_cycles SET status = 'PAID', transaction_hash = $3, failure_reason = NULL WHERE organization_id = $1 AND id = $2`,
          [action.organization_id, action.target_id, transactionHash],
        );
        await insertRecurringLedger(db, action, transactionHash);
        await recordNotification(db, {
          organizationId: action.organization_id,
          type: 'RECURRING_PAYMENT_SETTLED',
          priority: 'SUCCESS',
          title: 'Recurring payment settled',
          body: 'The scheduled payment cycle was completed successfully.',
          subjectType: 'subscription_cycle',
          subjectId: action.target_id,
          actionView: 'agreements',
          dedupeKey: `recurring-settled:${action.id}`,
          metadata: { transactionHash },
        });
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Recurring execution failed';
      await this.database.withWorker(async (db) => {
        await db.query(
          `UPDATE opes.lifecycle_chain_actions SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`,
          [action.id, reason],
        );
        await db.query(
          `UPDATE opes.subscription_cycles SET status = 'FAILED', failure_reason = $3 WHERE organization_id = $1 AND id = $2`,
          [action.organization_id, action.target_id, reason],
        );
        await recordNotification(db, {
          organizationId: action.organization_id,
          type: 'RECURRING_PAYMENT_FAILED',
          priority: 'WARNING',
          title: 'Recurring payment failed',
          body: reason.slice(0, 500),
          subjectType: 'subscription_cycle',
          subjectId: action.target_id,
          actionView: 'agreements',
          dedupeKey: `recurring-failed:${action.id}`,
        });
      });
    }
  }

  private async recurringEvidence(
    action: ActionRow,
  ): Promise<LifecycleExecutionEvidence> {
    const result = await this.database.withWorker((db) =>
      db.query<{
        amount_atomic: string;
        cycle_index: number;
        subscription_id: string;
        mandate_id: string;
        payout_address: string;
        vault_address: string;
        wallet_id: string;
        wallet_address: string;
      }>(
        `SELECT cycle.amount_atomic::text AS amount_atomic, cycle.cycle_index, cycle.subscription_id,
                subscription.mandate_id, address.payout_address,
                vault.address AS vault_address, wallet.resource_id AS wallet_id,
                wallet.address AS wallet_address
           FROM opes.subscription_cycles cycle
           JOIN opes.subscriptions subscription ON subscription.organization_id=cycle.organization_id AND subscription.id=cycle.subscription_id
           JOIN opes.vendor_payout_addresses address ON address.organization_id=subscription.organization_id AND address.id=subscription.vendor_address_id
           JOIN opes.tenant_resource_bindings vault ON vault.organization_id=cycle.organization_id AND vault.environment='arc-testnet' AND vault.resource_type='business_policy_vault_contract' AND vault.status='ACTIVE'
           JOIN opes.tenant_resource_bindings wallet ON wallet.organization_id=cycle.organization_id AND wallet.environment='arc-testnet' AND wallet.resource_type='operator_wallet' AND wallet.status='ACTIVE'
          WHERE cycle.organization_id=$1 AND cycle.id=$2 LIMIT 1`,
        [action.organization_id, action.target_id],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new Error('Recurring execution bindings are missing');
    const obligationKey = keccak256(
      stringToHex(
        `opes:subscription-cycle:${row.subscription_id}:${row.cycle_index}`,
      ),
    );
    return {
      walletId: row.wallet_id,
      walletAddress: row.wallet_address,
      contractAddress: row.vault_address,
      callData: action.call_data,
      tokenAddress: this.manifests.getArcTestnetFactory().tokenAddress,
      transferFrom: row.vault_address,
      transferTo: row.payout_address,
      amountAtomic: row.amount_atomic,
      eventAddress: row.vault_address,
      eventSignature: 'RecurringPaymentExecuted(bytes32,bytes32,uint256)',
      eventTopics: [row.mandate_id, obligationKey],
    };
  }
}

function recurringActionNotification(actionType: string) {
  if (actionType === 'CREATE_RECURRING_MANDATE')
    return {
      type: 'RECURRING_ACTIVATED',
      priority: 'SUCCESS' as const,
      title: 'Recurring agreement activated',
      body: 'OPES will execute eligible payment cycles on their scheduled dates.',
    };
  if (actionType === 'PAUSE_RECURRING_MANDATE')
    return {
      type: 'RECURRING_PAUSED',
      priority: 'WARNING' as const,
      title: 'Recurring agreement paused',
      body: 'Scheduled payments are stopped until the agreement is resumed.',
    };
  if (actionType === 'RESUME_RECURRING_MANDATE')
    return {
      type: 'RECURRING_RESUMED',
      priority: 'SUCCESS' as const,
      title: 'Recurring agreement resumed',
      body: 'Future eligible cycles can execute again.',
    };
  if (actionType === 'CANCEL_RECURRING_MANDATE')
    return {
      type: 'RECURRING_CANCELLED',
      priority: 'WARNING' as const,
      title: 'Recurring agreement cancelled',
      body: 'Remaining payment cycles were cancelled.',
    };
  return null;
}

export function buildSchedule(
  anchor: string,
  cadence: string,
  timezone: string,
  now = new Date(),
) {
  const result: Array<{
    start: string;
    end: string;
    dueAt: Date;
    endAt: Date;
  }> = [];
  let start = anchor;
  while (
    new Date(dueAtUtc(start, timezone)).getTime() <=
    now.getTime() + 300_000
  )
    start = addPeriod(start, cadence);
  for (let index = 0; index < 12; index += 1) {
    const end = addPeriod(start, cadence);
    result.push({
      start,
      end,
      dueAt: new Date(dueAtUtc(start, timezone)),
      endAt: new Date(`${end}T23:59:59Z`),
    });
    start = end;
  }
  return result;
}

export async function insertAction(
  database: TenantDatabase,
  organizationId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  actor: 'OWNER' | 'OPERATOR',
  contractAddress: string,
  callData: string,
  payload: Record<string, unknown>,
): Promise<ActionRow> {
  const result = await database.query<ActionRow>(
    `INSERT INTO opes.lifecycle_chain_actions (organization_id, action_type, target_type, target_id, actor, contract_address, call_data, payload, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (organization_id, action_type, target_id) DO UPDATE SET updated_at = opes.lifecycle_chain_actions.updated_at
     RETURNING *`,
    [
      organizationId,
      actionType,
      targetType,
      targetId,
      actor,
      contractAddress,
      callData,
      JSON.stringify(payload),
      stableUuid(`${organizationId}:${actionType}:${targetId}`),
    ],
  );
  return result.rows[0];
}

export function mapAction(row: ActionRow): ChainActionResponse {
  return {
    id: row.id,
    actionType: row.action_type,
    actor: row.actor,
    to: row.contract_address,
    data: row.call_data,
    chainId: ARC_CHAIN_ID,
    status: row.status,
  };
}

async function verifyOwnerTransaction(
  action: ActionRow & { owner_address: string },
  transactionHash: string,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))
    throw new ConflictException('Invalid transaction hash');
  const [transaction, receipt] = await Promise.all([
    rpc<{ from: string; to: string; input: string } | null>(
      'eth_getTransactionByHash',
      [transactionHash],
    ),
    rpc<{ status: string } | null>('eth_getTransactionReceipt', [
      transactionHash,
    ]),
  ]);
  if (!transaction || !receipt)
    throw new ConflictException('Owner transaction is not final');
  if (
    receipt.status !== '0x1' ||
    transaction.from.toLowerCase() !== action.owner_address.toLowerCase() ||
    transaction.to.toLowerCase() !== action.contract_address.toLowerCase() ||
    transaction.input.toLowerCase() !== action.call_data.toLowerCase()
  )
    throw new ConflictException(
      'Owner transaction does not match the prepared action',
    );
}

function recurringDecisionHash(input: {
  organizationId: string;
  vault: string;
  token: string;
  mandateId: string;
  cycleIndex: number;
  obligationKey: string;
  contextHash: string;
  vendor: string;
  amount: string;
  expiresAt: number;
}): `0x${string}` {
  const types = [
    'uint256',
    'uint256',
    'address',
    'bytes32',
    'address',
    'uint8',
    'bytes32',
    'address',
    'uint256',
    'uint64',
    'bytes32',
    'bytes32',
    'uint32',
    'bytes32',
  ].map((type) => ({ type })) as Parameters<typeof encodeAbiParameters>[0];
  return keccak256(
    encodeAbiParameters(types, [
      1n,
      BigInt(ARC_CHAIN_ID),
      input.vault as `0x${string}`,
      organizationDomain(input.organizationId, 'arc-testnet') as `0x${string}`,
      input.token as `0x${string}`,
      2,
      input.obligationKey as `0x${string}`,
      input.vendor as `0x${string}`,
      BigInt(input.amount),
      BigInt(input.expiresAt),
      `0x${'0'.repeat(64)}`,
      input.mandateId as `0x${string}`,
      input.cycleIndex,
      input.contextHash as `0x${string}`,
    ]),
  );
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.OPES_RPC_ARC_TESTNET?.trim();
  if (!url) throw new Error('OPES_RPC_ARC_TESTNET is not configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (!response.ok || body.error || body.result === undefined)
    throw new Error(body.error?.message ?? `Arc RPC HTTP ${response.status}`);
  return body.result;
}

function stableUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function insertRecurringLedger(
  database: TenantDatabase,
  action: ActionRow,
  transactionHash: string,
): Promise<void> {
  const amount = String(action.payload.amountAtomic);
  for (const [line, account, direction] of [
    [1, 'EXPENSE:RECURRING', 'DEBIT'],
    [2, 'ASSET:OPERATING_USDC', 'CREDIT'],
  ] as const) {
    await database.query(
      `INSERT INTO opes.ledger_entries (organization_id, ledger_event_type, ledger_event_id, line_number, account, direction, asset_symbol, amount_atomic, source_type, source_id, transaction_hash)
      VALUES ($1, 'RECURRING_PAYMENT_SETTLED', $2, $3, $4, $5, 'USDC', $6, 'SUBSCRIPTION_CYCLE', $2, $7)
      ON CONFLICT (organization_id, ledger_event_type, ledger_event_id, line_number) DO NOTHING`,
      [
        action.organization_id,
        action.target_id,
        line,
        account,
        direction,
        amount,
        transactionHash,
      ],
    );
  }
}
