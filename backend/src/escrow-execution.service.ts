import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from 'viem';
import escrowJson from './abi/MilestoneEscrow.json';
import vaultJson from './abi/BusinessPolicyVault.json';
import { DatabaseService } from './database.service';
import { CircleWalletService } from './circle-wallet.service';
import { FactoryManifestService } from './factory-manifest.service';
import { organizationDomain } from './evm-decision-hash';
import { TenantContext } from './tenant-context';
import {
  ActionRow,
  ChainActionResponse,
  insertAction,
  mapAction,
} from './recurring-execution.service';

const escrowAbi = escrowJson as Parameters<typeof encodeFunctionData>[0]['abi'];
const vaultAbi = vaultJson as Parameters<typeof encodeFunctionData>[0]['abi'];

@Injectable()
export class EscrowExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly circle: CircleWalletService,
    private readonly manifests: FactoryManifestService,
  ) {}

  async prepareAgreement(
    context: TenantContext,
    agreementId: string,
  ): Promise<ChainActionResponse[]> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Escrow activation requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        id: string;
        total_amount_atomic: string;
        payout_address: string;
        vault_address: string;
        escrow_address: string;
        amounts: string[];
        titles: string[];
      }>(
        `SELECT agreement.id, agreement.total_amount_atomic::text, address.payout_address,
                 vault.address AS vault_address, escrow.address AS escrow_address,
                 array_agg(milestone.amount_atomic::text ORDER BY milestone.milestone_index) AS amounts,
                 array_agg(milestone.title ORDER BY milestone.milestone_index) AS titles
            FROM opes.escrow_agreements agreement
            JOIN opes.escrow_milestones milestone ON milestone.organization_id = agreement.organization_id AND milestone.agreement_id = agreement.id
            JOIN opes.vendor_payout_addresses address ON address.organization_id = agreement.organization_id AND address.id = agreement.vendor_address_id AND address.status = 'VERIFIED_ACTIVE'
            JOIN opes.tenant_resource_bindings vault ON vault.organization_id = agreement.organization_id AND vault.environment = 'arc-testnet' AND vault.resource_type = 'business_policy_vault_contract' AND vault.status = 'ACTIVE'
            JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id = agreement.organization_id AND escrow.environment = 'arc-testnet' AND escrow.resource_type = 'milestone_escrow_contract' AND escrow.status = 'ACTIVE'
           WHERE agreement.organization_id = $1 AND agreement.id = $2
           GROUP BY agreement.id, address.payout_address, vault.address, escrow.address`,
        [context.organizationId, agreementId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Escrow setup is incomplete');
      const chainId = keccak256(stringToHex(`opes:escrow:${agreementId}`));
      const now = Math.floor(Date.now() / 1000);
      const fundingDeadline = now + 7 * 86_400;
      const completionDeadline = now + 90 * 86_400;
      await db.query(
        `UPDATE opes.escrow_agreements SET status='SETUP_REQUIRED', chain_agreement_id=$3, funding_deadline=to_timestamp($4), completion_deadline=to_timestamp($5), updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [
          context.organizationId,
          agreementId,
          chainId,
          fundingDeadline,
          completionDeadline,
        ],
      );
      const actions: Array<[string, string, string]> = [
        [
          'SET_ESCROW_LIMITS',
          row.vault_address,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: 'setLimits',
            args: [
              BigInt(row.total_amount_atomic),
              BigInt(row.total_amount_atomic),
              BigInt(row.total_amount_atomic),
            ],
          }),
        ],
        [
          'SET_ESCROW_POLICY',
          row.vault_address,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: 'setEscrow',
            args: [row.escrow_address as `0x${string}`, true],
          }),
        ],
        [
          'SET_ESCROW_VENDOR',
          row.vault_address,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: 'setVendor',
            args: [
              row.payout_address as `0x${string}`,
              true,
              BigInt(row.total_amount_atomic),
            ],
          }),
        ],
        [
          'CREATE_ESCROW_AGREEMENT',
          row.escrow_address,
          encodeFunctionData({
            abi: escrowAbi,
            functionName: 'createAgreement',
            args: [
              chainId,
              row.payout_address as `0x${string}`,
              row.vault_address as `0x${string}`,
              keccak256(stringToHex(`opes:terms:${agreementId}`)),
              row.amounts.map(BigInt),
              row.titles.map((title, index) =>
                keccak256(stringToHex(`${index}:${title}`)),
              ),
              true,
              BigInt(fundingDeadline),
              BigInt(completionDeadline),
            ],
          }),
        ],
      ];
      const output: ChainActionResponse[] = [];
      for (const [type, to, data] of actions)
        output.push(
          mapAction(
            await insertAction(
              db,
              context.organizationId,
              type,
              'escrow_agreement',
              agreementId,
              'OWNER',
              to,
              data,
              { chainAgreementId: chainId },
            ),
          ),
        );
      return output;
    });
  }

  async prepareMilestoneApproval(context: TenantContext, milestoneId: string) {
    if (context.role !== 'OWNER')
      throw new ConflictException('Milestone approval requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        agreement_id: string;
        milestone_index: number;
        evidence_document_id: string;
        evidence_sha256_hex: string;
        chain_agreement_id: string;
        escrow_address: string;
        completion_deadline: Date;
      }>(
        `SELECT milestone.agreement_id, milestone.milestone_index, milestone.evidence_document_id, document.sha256_hex AS evidence_sha256_hex, agreement.chain_agreement_id,
                escrow.address AS escrow_address, agreement.completion_deadline
           FROM opes.escrow_milestones milestone JOIN opes.escrow_agreements agreement ON agreement.organization_id=milestone.organization_id AND agreement.id=milestone.agreement_id
           JOIN opes.evidence_documents document ON document.organization_id=milestone.organization_id AND document.id=milestone.evidence_document_id AND document.status='VERIFIED'
           JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id=milestone.organization_id AND escrow.environment='arc-testnet' AND escrow.resource_type='milestone_escrow_contract' AND escrow.status='ACTIVE'
          WHERE milestone.organization_id=$1 AND milestone.id=$2 AND milestone.status='SUBMITTED' AND milestone.evidence_document_id IS NOT NULL AND agreement.status='FUNDED'`,
        [context.organizationId, milestoneId],
      );
      const row = result.rows[0];
      if (!row)
        throw new NotFoundException('Funded submitted milestone not found');
      const expiresAt = Math.min(
        Math.floor(row.completion_deadline.getTime() / 1000),
        Math.floor(Date.now() / 1000) + 7 * 86_400,
      );
      const decision = keccak256(
        stringToHex(`opes:milestone-decision:${milestoneId}`),
      );
      const evidence = `0x${row.evidence_sha256_hex}`;
      const owner = await insertAction(
        db,
        context.organizationId,
        'APPROVE_ESCROW_MILESTONE',
        'escrow_milestone',
        milestoneId,
        'OWNER',
        row.escrow_address,
        encodeFunctionData({
          abi: escrowAbi,
          functionName: 'approveMilestone',
          args: [
            row.chain_agreement_id as `0x${string}`,
            row.milestone_index,
            decision,
            evidence,
            BigInt(expiresAt),
          ],
        }),
        { agreementId: row.agreement_id },
      );
      const wallet = await this.operatorWallet(db, context.organizationId);
      await insertAction(
        db,
        context.organizationId,
        'RELEASE_ESCROW_MILESTONE',
        'escrow_milestone',
        milestoneId,
        'OPERATOR',
        row.escrow_address,
        encodeFunctionData({
          abi: escrowAbi,
          functionName: 'releaseMilestone',
          args: [
            row.chain_agreement_id as `0x${string}`,
            row.milestone_index,
            keccak256(stringToHex(`opes:release:${milestoneId}`)),
          ],
        }),
        { walletId: wallet, requiresActionId: owner.id },
      );
      return mapAction(owner);
    });
  }

  async prepareFunding(context: TenantContext, agreementId: string) {
    if (context.role !== 'OWNER')
      throw new ConflictException('Escrow funding requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        chain_agreement_id: string;
        total_amount_atomic: string;
        vault_address: string;
        escrow_address: string;
        wallet_id: string;
      }>(
        `SELECT agreement.chain_agreement_id,agreement.total_amount_atomic::text,vault.address AS vault_address,escrow.address AS escrow_address,wallet.resource_id AS wallet_id FROM opes.escrow_agreements agreement JOIN opes.tenant_resource_bindings vault ON vault.organization_id=agreement.organization_id AND vault.environment='arc-testnet' AND vault.resource_type='business_policy_vault_contract' AND vault.status='ACTIVE' JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id=agreement.organization_id AND escrow.environment='arc-testnet' AND escrow.resource_type='milestone_escrow_contract' AND escrow.status='ACTIVE' JOIN opes.tenant_resource_bindings wallet ON wallet.organization_id=agreement.organization_id AND wallet.environment='arc-testnet' AND wallet.resource_type='operator_wallet' AND wallet.status='ACTIVE' WHERE agreement.organization_id=$1 AND agreement.id=$2 AND agreement.status='CREATED'`,
        [context.organizationId, agreementId],
      );
      const row = result.rows[0];
      if (!row)
        throw new NotFoundException('Created escrow agreement not found');
      const key = keccak256(stringToHex(`opes:escrow-funding:${agreementId}`));
      const contextHash = keccak256(
        stringToHex(`opes:escrow-context:${agreementId}`),
      );
      const expiresAt = Math.floor(Date.now() / 1000) + 6 * 86_400;
      const decision = escrowDecisionHash(
        context.organizationId,
        row.vault_address,
        this.manifests.getArcTestnetFactory().tokenAddress,
        key,
        contextHash,
        row.escrow_address,
        row.chain_agreement_id,
        row.total_amount_atomic,
        expiresAt,
      );
      const owner = await insertAction(
        db,
        context.organizationId,
        'APPROVE_ESCROW_FUNDING',
        'escrow_agreement',
        agreementId,
        'OWNER',
        row.vault_address,
        encodeFunctionData({
          abi: vaultAbi,
          functionName: 'approveDecision',
          args: [decision, BigInt(expiresAt)],
        }),
        {},
      );
      await insertAction(
        db,
        context.organizationId,
        'FUND_ESCROW',
        'escrow_agreement',
        agreementId,
        'OPERATOR',
        row.vault_address,
        encodeFunctionData({
          abi: vaultAbi,
          functionName: 'fundEscrow',
          args: [
            decision,
            key,
            contextHash,
            key,
            row.escrow_address as `0x${string}`,
            row.chain_agreement_id as `0x${string}`,
            BigInt(row.total_amount_atomic),
            BigInt(expiresAt),
          ],
        }),
        {
          walletId: row.wallet_id,
          requiresActionId: owner.id,
          amountAtomic: row.total_amount_atomic,
        },
      );
      return mapAction(owner);
    });
  }

  async prepareDispute(
    context: TenantContext,
    milestoneId: string,
    reason: string,
  ) {
    return this.prepareMilestoneAdminAction(
      context,
      milestoneId,
      'DISPUTE_ESCROW_MILESTONE',
      'disputeMilestone',
      reason,
    );
  }

  async prepareCancel(
    context: TenantContext,
    agreementId: string,
    reason: string,
  ) {
    if (context.role !== 'OWNER')
      throw new ConflictException('Escrow cancellation requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        chain_agreement_id: string;
        escrow_address: string;
      }>(
        `SELECT agreement.chain_agreement_id, escrow.address AS escrow_address FROM opes.escrow_agreements agreement JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id=agreement.organization_id AND escrow.environment='arc-testnet' AND escrow.resource_type='milestone_escrow_contract' AND escrow.status='ACTIVE' WHERE agreement.organization_id=$1 AND agreement.id=$2 AND agreement.chain_agreement_id IS NOT NULL`,
        [context.organizationId, agreementId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Escrow agreement not found');
      return mapAction(
        await insertAction(
          db,
          context.organizationId,
          'CANCEL_ESCROW_AGREEMENT',
          'escrow_agreement',
          agreementId,
          'OWNER',
          row.escrow_address,
          encodeFunctionData({
            abi: escrowAbi,
            functionName: 'cancelAgreement',
            args: [
              row.chain_agreement_id as `0x${string}`,
              keccak256(stringToHex(reason)),
            ],
          }),
          {},
        ),
      );
    });
  }

  async ownerActionConfirmed(context: TenantContext, actionId: string) {
    await this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        action_type: string;
        target_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT action_type,target_id,payload FROM opes.lifecycle_chain_actions WHERE organization_id=$1 AND id=$2 AND status='CONFIRMED'`,
        [context.organizationId, actionId],
      );
      const action = result.rows[0];
      if (!action) return;
      if (action.action_type === 'CREATE_ESCROW_AGREEMENT')
        await db.query(
          `UPDATE opes.escrow_agreements SET status='CREATED', updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [context.organizationId, action.target_id],
        );
      if (action.action_type === 'APPROVE_ESCROW_MILESTONE')
        await db.query(
          `UPDATE opes.escrow_milestones SET status='ACCEPTED', accepted_by_membership_id=$3, accepted_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [context.organizationId, action.target_id, context.membershipId],
        );
      if (action.action_type === 'DISPUTE_ESCROW_MILESTONE')
        await db.query(
          `UPDATE opes.escrow_milestones SET status='DISPUTED', updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [context.organizationId, action.target_id],
        );
      if (action.action_type === 'CANCEL_ESCROW_AGREEMENT')
        await db.query(
          `UPDATE opes.escrow_agreements SET status='CANCELLED', updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [context.organizationId, action.target_id],
        );
      if (action.action_type === 'CANCEL_ESCROW_AGREEMENT') {
        const row = (
          await db.query<{
            chain_agreement_id: string;
            escrow_address: string;
          }>(
            `SELECT agreement.chain_agreement_id,escrow.address AS escrow_address FROM opes.escrow_agreements agreement JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id=agreement.organization_id AND escrow.environment='arc-testnet' AND escrow.resource_type='milestone_escrow_contract' AND escrow.status='ACTIVE' WHERE agreement.organization_id=$1 AND agreement.id=$2`,
            [context.organizationId, action.target_id],
          )
        ).rows[0];
        if (row)
          await insertAction(
            db,
            context.organizationId,
            'REFUND_ESCROW',
            'escrow_agreement',
            action.target_id,
            'OPERATOR',
            row.escrow_address,
            encodeFunctionData({
              abi: escrowAbi,
              functionName: 'refundUnreleased',
              args: [
                row.chain_agreement_id as `0x${string}`,
                keccak256(stringToHex(`opes:refund:${action.target_id}`)),
              ],
            }),
            {
              walletId: await this.operatorWallet(db, context.organizationId),
              requiresActionId: actionId,
            },
          );
      }
    });
  }

  async processDue(limit = 10) {
    const actions = await this.database.withWorker((db) =>
      db.query<ActionRow>(
        `SELECT action.* FROM opes.lifecycle_chain_actions action LEFT JOIN opes.lifecycle_chain_actions required ON required.id=(action.payload->>'requiresActionId')::uuid WHERE action.actor='OPERATOR' AND action.action_type IN ('FUND_ESCROW','RELEASE_ESCROW_MILESTONE','REFUND_ESCROW') AND action.status IN ('PREPARED','SUBMITTED') AND (required.id IS NULL OR required.status='CONFIRMED') ORDER BY action.created_at FOR UPDATE OF action SKIP LOCKED LIMIT $1`,
        [limit],
      ),
    );
    for (const action of actions.rows) await this.execute(action);
    return actions.rows.length;
  }

  private async execute(action: ActionRow) {
    try {
      let provider = action.provider_transaction_id;
      if (!provider) {
        const submitted = await this.circle.createCallDataTransaction({
          walletId: String(action.payload.walletId),
          contractAddress: action.contract_address,
          callData: action.call_data,
          idempotencyKey: action.idempotency_key,
        });
        provider = submitted.id;
        await this.database.withWorker((db) =>
          db.query(
            `UPDATE opes.lifecycle_chain_actions SET status='SUBMITTED',provider_transaction_id=$2,submitted_at=now(),updated_at=now() WHERE id=$1`,
            [action.id, provider],
          ),
        );
      }
      const transaction = await this.circle.getTransaction(provider);
      if (!transaction.txHash) return;
      const [tx, receipt] = await Promise.all([
        rpc<{ to: string; input: string } | null>('eth_getTransactionByHash', [
          transaction.txHash,
        ]),
        rpc<{ status: string } | null>('eth_getTransactionReceipt', [
          transaction.txHash,
        ]),
      ]);
      if (!tx || !receipt) return;
      if (
        receipt.status !== '0x1' ||
        tx.to.toLowerCase() !== action.contract_address.toLowerCase() ||
        tx.input.toLowerCase() !== action.call_data.toLowerCase()
      )
        throw new Error('Escrow transaction evidence mismatch');
      await this.database.withWorker(async (db) => {
        await db.query(
          `UPDATE opes.lifecycle_chain_actions SET status='CONFIRMED',transaction_hash=$2,confirmed_at=now(),updated_at=now() WHERE id=$1`,
          [action.id, transaction.txHash],
        );
        if (action.action_type === 'FUND_ESCROW')
          await db.query(
            `UPDATE opes.escrow_agreements SET status='FUNDED',transaction_hash=$3,updated_at=now() WHERE organization_id=$1 AND id=$2`,
            [action.organization_id, action.target_id, transaction.txHash],
          );
        if (action.action_type === 'RELEASE_ESCROW_MILESTONE')
          await db.query(
            `UPDATE opes.escrow_milestones SET status='RELEASED',transaction_hash=$3,updated_at=now() WHERE organization_id=$1 AND id=$2`,
            [action.organization_id, action.target_id, transaction.txHash],
          );
        if (action.action_type === 'RELEASE_ESCROW_MILESTONE')
          await db.query(
            `UPDATE opes.escrow_agreements agreement SET status='COMPLETED',updated_at=now() WHERE agreement.organization_id=$1 AND agreement.id=(SELECT agreement_id FROM opes.escrow_milestones WHERE organization_id=$1 AND id=$2) AND NOT EXISTS (SELECT 1 FROM opes.escrow_milestones milestone WHERE milestone.organization_id=agreement.organization_id AND milestone.agreement_id=agreement.id AND milestone.status<>'RELEASED')`,
            [action.organization_id, action.target_id],
          );
        if (action.action_type === 'REFUND_ESCROW') {
          await db.query(
            `UPDATE opes.escrow_milestones SET status='REFUNDED',transaction_hash=$3,updated_at=now() WHERE organization_id=$1 AND agreement_id=$2 AND status NOT IN ('RELEASED','REFUNDED')`,
            [action.organization_id, action.target_id, transaction.txHash],
          );
        }
        await insertEscrowLedger(db, action, transaction.txHash!);
      });
    } catch (error) {
      await this.database.withWorker((db) =>
        db.query(
          `UPDATE opes.lifecycle_chain_actions SET status='FAILED',failure_reason=$2,updated_at=now() WHERE id=$1`,
          [
            action.id,
            error instanceof Error ? error.message : 'Escrow execution failed',
          ],
        ),
      );
    }
  }

  private async operatorWallet(
    db: Parameters<Parameters<DatabaseService['withTenant']>[1]>[0],
    organizationId: string,
  ) {
    const result = await db.query<{ resource_id: string }>(
      `SELECT resource_id FROM opes.tenant_resource_bindings WHERE organization_id=$1 AND environment='arc-testnet' AND resource_type='operator_wallet' AND status='ACTIVE' LIMIT 1`,
      [organizationId],
    );
    if (!result.rows[0])
      throw new NotFoundException('Operator wallet not found');
    return result.rows[0].resource_id;
  }

  private async prepareMilestoneAdminAction(
    context: TenantContext,
    milestoneId: string,
    type: string,
    functionName: 'disputeMilestone',
    reason: string,
  ) {
    if (context.role !== 'OWNER')
      throw new ConflictException('Escrow dispute requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        chain_agreement_id: string;
        milestone_index: number;
        escrow_address: string;
      }>(
        `SELECT agreement.chain_agreement_id,milestone.milestone_index,escrow.address AS escrow_address FROM opes.escrow_milestones milestone JOIN opes.escrow_agreements agreement ON agreement.organization_id=milestone.organization_id AND agreement.id=milestone.agreement_id JOIN opes.tenant_resource_bindings escrow ON escrow.organization_id=milestone.organization_id AND escrow.environment='arc-testnet' AND escrow.resource_type='milestone_escrow_contract' AND escrow.status='ACTIVE' WHERE milestone.organization_id=$1 AND milestone.id=$2`,
        [context.organizationId, milestoneId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Escrow milestone not found');
      return mapAction(
        await insertAction(
          db,
          context.organizationId,
          type,
          'escrow_milestone',
          milestoneId,
          'OWNER',
          row.escrow_address,
          encodeFunctionData({
            abi: escrowAbi,
            functionName,
            args: [
              row.chain_agreement_id as `0x${string}`,
              row.milestone_index,
              keccak256(stringToHex(reason)),
            ],
          }),
          {},
        ),
      );
    });
  }
}

export function escrowDecisionHash(
  organizationId: string,
  vault: string,
  token: string,
  key: string,
  contextHash: string,
  escrow: string,
  agreement: string,
  amount: string,
  expiresAt: number,
) {
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
      5042002n,
      vault as `0x${string}`,
      organizationDomain(organizationId, 'arc-testnet') as `0x${string}`,
      token as `0x${string}`,
      3,
      key as `0x${string}`,
      escrow as `0x${string}`,
      BigInt(amount),
      BigInt(expiresAt),
      agreement as `0x${string}`,
      `0x${'0'.repeat(64)}`,
      0,
      contextHash as `0x${string}`,
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
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function insertEscrowLedger(
  db: Parameters<Parameters<DatabaseService['withWorker']>[0]>[0],
  action: ActionRow,
  transactionHash: string,
) {
  const definitions: Record<string, [string, string, string, string]> = {
    FUND_ESCROW: [
      'ESCROW_FUNDED',
      'escrow_agreements',
      'ASSET:ESCROW_USDC',
      'ASSET:OPERATING_USDC',
    ],
    RELEASE_ESCROW_MILESTONE: [
      'ESCROW_MILESTONE_RELEASED',
      'escrow_milestones',
      'EXPENSE:ESCROW_MILESTONE',
      'ASSET:ESCROW_USDC',
    ],
    REFUND_ESCROW: [
      'ESCROW_REFUNDED',
      'escrow_agreements',
      'ASSET:OPERATING_USDC',
      'ASSET:ESCROW_USDC',
    ],
  };
  const definition = definitions[action.action_type];
  if (!definition) return;
  const amount =
    action.action_type === 'RELEASE_ESCROW_MILESTONE'
      ? (
          await db.query<{ amount: string }>(
            `SELECT amount_atomic::text AS amount FROM opes.escrow_milestones WHERE organization_id=$1 AND id=$2`,
            [action.organization_id, action.target_id],
          )
        ).rows[0]?.amount
      : action.action_type === 'FUND_ESCROW'
        ? (
            await db.query<{ amount: string }>(
              `SELECT total_amount_atomic::text AS amount FROM opes.escrow_agreements WHERE organization_id=$1 AND id=$2`,
              [action.organization_id, action.target_id],
            )
          ).rows[0]?.amount
        : (
            await db.query<{ amount: string }>(
              `SELECT COALESCE(sum(amount_atomic) FILTER (WHERE status='REFUNDED'),0)::text AS amount FROM opes.escrow_milestones WHERE organization_id=$1 AND agreement_id=$2`,
              [action.organization_id, action.target_id],
            )
          ).rows[0]?.amount;
  if (!amount || amount === '0')
    throw new Error('Escrow ledger amount is missing');
  for (const [line, account, direction] of [
    [1, definition[2], 'DEBIT'],
    [2, definition[3], 'CREDIT'],
  ] as const)
    await db.query(
      `INSERT INTO opes.ledger_entries (organization_id,ledger_event_type,ledger_event_id,line_number,account,direction,asset_symbol,amount_atomic,source_type,source_id,transaction_hash) VALUES ($1,$2,$3,$4,$5,$6,'USDC',$7,$8,$9,$10) ON CONFLICT (organization_id,ledger_event_type,ledger_event_id,line_number) DO NOTHING`,
      [
        action.organization_id,
        definition[0],
        action.id,
        line,
        account,
        direction,
        amount,
        definition[1],
        action.target_id,
        transactionHash,
      ],
    );
}
