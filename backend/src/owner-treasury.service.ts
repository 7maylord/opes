import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import vaultJson from './abi/BusinessPolicyVault.json';
import escrowJson from './abi/MilestoneEscrow.json';
import { DatabaseService } from './database.service';
import {
  ChainActionResponse,
  insertAction,
  mapAction,
} from './recurring-execution.service';
import { TenantContext } from './tenant-context';

const vaultAbi = vaultJson as Parameters<typeof encodeFunctionData>[0]['abi'];
const escrowAbi = escrowJson as Parameters<typeof encodeFunctionData>[0]['abi'];
type ControlAction =
  | 'PAUSE_VAULT'
  | 'RESUME_VAULT'
  | 'PAUSE_ESCROW'
  | 'RESUME_ESCROW'
  | 'SET_LIMITS'
  | 'SET_VENDOR'
  | 'RECOVER_USDC'
  | 'HANDOVER_VAULT'
  | 'HANDOVER_ESCROW';

@Injectable()
export class OwnerTreasuryService {
  constructor(private readonly database: DatabaseService) {}

  async prepare(
    context: TenantContext,
    input: {
      action: ControlAction;
      autonomousAtomic?: string;
      singleAtomic?: string;
      dailyAtomic?: string;
      vendor?: string;
      allowed?: boolean;
      amountAtomic?: string;
      newAdmin?: string;
    },
  ): Promise<ChainActionResponse> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Treasury controls require the owner');
    return this.database.withTenant(context, async (db) => {
      const bindings = await db.query<{
        resource_type: string;
        address: string;
      }>(
        `SELECT resource_type,address FROM opes.tenant_resource_bindings WHERE organization_id=$1 AND environment='arc-testnet' AND resource_type IN ('business_policy_vault_contract','milestone_escrow_contract') AND status='ACTIVE'`,
        [context.organizationId],
      );
      const vault = bindings.rows.find(
        (row) => row.resource_type === 'business_policy_vault_contract',
      )?.address;
      const escrow = bindings.rows.find(
        (row) => row.resource_type === 'milestone_escrow_contract',
      )?.address;
      const target = input.action.includes('ESCROW') ? escrow : vault;
      if (!target)
        throw new NotFoundException('Active treasury contract not found');
      if (input.action === 'RECOVER_USDC') {
        const pending = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM (
             SELECT id FROM opes.payment_executions WHERE organization_id=$1 AND status IN ('PENDING','PROCESSING','SUBMITTED')
             UNION ALL SELECT id FROM opes.subscription_cycles WHERE organization_id=$1 AND status='PROCESSING'
             UNION ALL SELECT id FROM opes.lifecycle_chain_actions WHERE organization_id=$1 AND actor='OPERATOR' AND status IN ('PREPARED','SUBMITTED')
           ) movement`,
          [context.organizationId],
        );
        if (pending.rows[0]?.count !== '0')
          throw new ConflictException(
            'Recovery is blocked while treasury movements are pending',
          );
      }
      const [functionName, args] = controlCall(input);
      const abi = input.action.includes('ESCROW') ? escrowAbi : vaultAbi;
      return mapAction(
        await insertAction(
          db,
          context.organizationId,
          input.action,
          'treasury_control',
          randomUUID(),
          'OWNER',
          target,
          encodeFunctionData({ abi, functionName, args }),
          { control: input.action, input },
        ),
      );
    });
  }

  async prepareDecisionApproval(
    context: TenantContext,
    decisionId: string,
  ): Promise<ChainActionResponse> {
    if (context.role !== 'OWNER')
      throw new ConflictException('Onchain approval requires the owner');
    return this.database.withTenant(context, async (db) => {
      const result = await db.query<{
        decision_hash: string;
        expires_at: Date;
        vault_address: string;
      }>(
        `SELECT decision.decision_hash,decision.expires_at,vault.address AS vault_address FROM opes.payment_decisions decision JOIN opes.tenant_resource_bindings vault ON vault.organization_id=decision.organization_id AND vault.environment='arc-testnet' AND vault.resource_type='business_policy_vault_contract' AND vault.status='ACTIVE' WHERE decision.organization_id=$1 AND decision.id=$2 AND decision.decision_hash IS NOT NULL`,
        [context.organizationId, decisionId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Executable decision not found');
      return mapAction(
        await insertAction(
          db,
          context.organizationId,
          'APPROVE_DIRECT_PAYMENT',
          'payment_decision',
          decisionId,
          'OWNER',
          row.vault_address,
          encodeFunctionData({
            abi: vaultAbi,
            functionName: 'approveDecision',
            args: [
              row.decision_hash as `0x${string}`,
              BigInt(Math.floor(row.expires_at.getTime() / 1000)),
            ],
          }),
          {},
        ),
      );
    });
  }
}

export function controlCall(input: {
  action: ControlAction;
  autonomousAtomic?: string;
  singleAtomic?: string;
  dailyAtomic?: string;
  vendor?: string;
  allowed?: boolean;
  amountAtomic?: string;
  newAdmin?: string;
}): [string, readonly unknown[]] {
  if (input.action.startsWith('PAUSE_')) return ['pause', []];
  if (input.action.startsWith('RESUME_')) return ['unpause', []];
  if (input.action === 'SET_LIMITS')
    return [
      'setLimits',
      [
        atomic(input.autonomousAtomic, 'autonomousAtomic'),
        atomic(input.singleAtomic, 'singleAtomic'),
        atomic(input.dailyAtomic, 'dailyAtomic'),
      ],
    ];
  if (input.action === 'SET_VENDOR') {
    if (!address(input.vendor))
      throw new BadRequestException('vendor must be an EVM address');
    return [
      'setVendor',
      [
        input.vendor,
        input.allowed === true,
        atomic(input.dailyAtomic, 'dailyAtomic'),
      ],
    ];
  }
  if (input.action === 'RECOVER_USDC')
    return ['recoverUsdc', [atomic(input.amountAtomic, 'amountAtomic')]];
  if (input.action.startsWith('HANDOVER_')) {
    if (!address(input.newAdmin))
      throw new BadRequestException('newAdmin must be an EVM address');
    return ['beginDefaultAdminTransfer', [input.newAdmin]];
  }
  throw new BadRequestException('Unsupported treasury action');
}
function atomic(value: string | undefined, name: string) {
  if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n)
    throw new BadRequestException(`${name} must be a positive atomic amount`);
  return BigInt(value);
}
function address(value: string | undefined) {
  return !!value && /^0x[0-9a-fA-F]{40}$/.test(value);
}
