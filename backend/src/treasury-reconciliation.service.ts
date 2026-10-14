import { Injectable, Logger } from '@nestjs/common';
import { encodeFunctionData, keccak256, stringToHex } from 'viem';
import tokenAbiJson from './abi/IERC20Metadata.json';
import { DatabaseService, TenantDatabase } from './database.service';
import { supportedNetworks } from './liquidity-policy';

const tokenAbi = tokenAbiJson as Parameters<
  typeof encodeFunctionData
>[0]['abi'];
const TRANSFER_TOPIC = keccak256(
  stringToHex('Transfer(address,address,uint256)'),
);
interface RpcLog {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
}

@Injectable()
export class TreasuryReconciliationService {
  private readonly logger = new Logger(TreasuryReconciliationService.name);
  constructor(private readonly database: DatabaseService) {}
  async process(limit = 25) {
    const tenants = await this.database.withWorker((db) =>
      db.query<{
        organization_id: string;
        environment: string;
        chain_id: number;
        addresses: string[];
      }>(
        `SELECT organization_id,environment,chain_id,
           array_agg(lower(address)) FILTER (WHERE address IS NOT NULL) AS addresses
         FROM opes.tenant_resource_bindings
         WHERE status='ACTIVE' AND address IS NOT NULL AND chain_id IS NOT NULL
           AND resource_type IN ('operator_wallet','business_policy_vault_contract','milestone_escrow_contract')
         GROUP BY organization_id,environment,chain_id LIMIT $1`,
        [limit],
      ),
    );
    for (const tenant of tenants.rows) {
      const network = supportedNetworks().find(
        (item) =>
          item.environment === tenant.environment &&
          item.chainId === tenant.chain_id,
      );
      if (!network) continue;
      try {
        await this.scanTenant(
          tenant.organization_id,
          tenant.environment,
          tenant.chain_id,
          network.usdc,
          tenant.addresses,
        );
      } catch (error) {
        await this.database.withWorker((db) =>
          db.query(
            `INSERT INTO opes.treasury_balance_reads
              (organization_id,environment,status,failure_reason)
             VALUES ($1,$2,'FAILED',$3)`,
            [
              tenant.organization_id,
              tenant.environment,
              error instanceof Error
                ? error.message.slice(0, 500)
                : 'Treasury balance read failed',
            ],
          ),
        );
        this.logger.error(
          `treasury reconciliation failed for ${tenant.organization_id}`,
          error,
        );
      }
    }
    return tenants.rows.length;
  }
  private async scanTenant(
    organizationId: string,
    environment: string,
    chainId: number,
    tokenAddress: string,
    addresses: string[],
  ) {
    const head = Number(
      BigInt(await rpc<string>(environment, 'eth_blockNumber', [])),
    );
    const finality = Number(
      process.env.OPES_RECONCILIATION_FINALITY_BLOCKS ?? '12',
    );
    const finalized = Math.max(0, head - finality);
    await this.database.withWorker(async (db) => {
      const cursor = (
        await db.query<{
          last_finalized_block: string;
          last_finalized_block_hash: string | null;
        }>(
          `SELECT last_finalized_block::text,last_finalized_block_hash FROM opes.chain_reconciliation_cursors WHERE organization_id=$1 AND environment=$2 FOR UPDATE`,
          [organizationId, environment],
        )
      ).rows[0];
      let from = cursor
        ? Number(cursor.last_finalized_block) + 1
        : Math.max(
            0,
            finalized -
              Number(process.env.OPES_RECONCILIATION_BACKFILL_BLOCKS ?? '5000'),
          );
      if (cursor?.last_finalized_block_hash) {
        const block = await rpc<{ hash: string } | null>(
          environment,
          'eth_getBlockByNumber',
          [hex(Number(cursor.last_finalized_block)), false],
        );
        if (
          !block ||
          block.hash.toLowerCase() !==
            cursor.last_finalized_block_hash.toLowerCase()
        ) {
          const rewind = Math.max(
            0,
            Number(cursor.last_finalized_block) - finality,
          );
          await db.query(
            `UPDATE opes.chain_movements SET status='REORGED',updated_at=now() WHERE organization_id=$1 AND environment=$2 AND block_number>$3`,
            [organizationId, environment, rewind],
          );
          await db.query(
            `UPDATE opes.treasury_exceptions exception SET status='RESOLVED',resolved_at=now()
              FROM opes.chain_movements movement WHERE exception.organization_id=$1
               AND exception.movement_id=movement.id AND movement.status='REORGED' AND exception.status='OPEN'`,
            [organizationId],
          );
          await db.query(
            `DELETE FROM opes.treasury_balance_snapshots WHERE organization_id=$1 AND environment=$2 AND block_number>$3`,
            [organizationId, environment, rewind],
          );
          from = rewind + 1;
        }
      }
      if (from <= finalized) {
        const logs = await rpc<RpcLog[]>(environment, 'eth_getLogs', [
          {
            address: tokenAddress,
            fromBlock: hex(from),
            toBlock: hex(finalized),
            topics: [TRANSFER_TOPIC],
          },
        ]);
        for (const log of logs) {
          const fromAddress = topicAddress(log.topics[1]);
          const toAddress = topicAddress(log.topics[2]);
          if (
            !addresses.includes(fromAddress) &&
            !addresses.includes(toAddress)
          )
            continue;
          await recordMovement(db, {
            organizationId,
            environment,
            chainId,
            log,
            fromAddress,
            toAddress,
          });
        }
      }
      await checkBalances(
        db,
        organizationId,
        environment,
        addresses,
        from,
        finalized,
        tokenAddress,
      );
      await db.query(
        `INSERT INTO opes.treasury_balance_reads
          (organization_id,environment,status,block_number)
         VALUES ($1,$2,'SUCCESS',$3)`,
        [organizationId, environment, finalized],
      );
      const block = await rpc<{ hash: string }>(
        environment,
        'eth_getBlockByNumber',
        [hex(finalized), false],
      );
      await db.query(
        `INSERT INTO opes.chain_reconciliation_cursors(organization_id,environment,chain_id,last_finalized_block,last_finalized_block_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,environment) DO UPDATE SET last_finalized_block=EXCLUDED.last_finalized_block,last_finalized_block_hash=EXCLUDED.last_finalized_block_hash,updated_at=now()`,
        [organizationId, environment, chainId, finalized, block.hash],
      );
      await postControlLedger(db, organizationId);
      await postSponsorLedger(db, organizationId);
    });
  }
}

export async function recordMovement(
  db: TenantDatabase,
  input: {
    organizationId: string;
    environment: string;
    chainId: number;
    log: RpcLog;
    fromAddress: string;
    toAddress: string;
  },
) {
  const amount = BigInt(input.log.data).toString();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO opes.chain_movements(organization_id,environment,chain_id,block_number,block_hash,transaction_hash,log_index,asset_symbol,from_address,to_address,amount_atomic,status) VALUES($1,$2,$3,$4,$5,$6,$7,'USDC',$8,$9,$10,'FINALIZED') ON CONFLICT(organization_id,chain_id,transaction_hash,log_index) DO UPDATE SET status='FINALIZED',block_hash=EXCLUDED.block_hash,updated_at=now() RETURNING id`,
    [
      input.organizationId,
      input.environment,
      input.chainId,
      Number(BigInt(input.log.blockNumber)),
      input.log.blockHash,
      input.log.transactionHash.toLowerCase(),
      Number(BigInt(input.log.logIndex)),
      input.fromAddress,
      input.toAddress,
      amount,
    ],
  );
  const movement = inserted.rows[0];
  if (!movement) return;
  const ledger = await db.query<{ id: string }>(
    `SELECT id FROM opes.ledger_entries WHERE organization_id=$1 AND lower(transaction_hash)=$2 AND asset_symbol='USDC' AND amount_atomic=$3 ORDER BY created_at LIMIT 1`,
    [input.organizationId, input.log.transactionHash.toLowerCase(), amount],
  );
  if (ledger.rows[0]) {
    await db.query(
      `UPDATE opes.chain_movements SET matched_ledger_entry_id=$2 WHERE id=$1`,
      [movement.id, ledger.rows[0].id],
    );
    await db.query(
      `UPDATE opes.treasury_exceptions SET status='RESOLVED',resolved_at=now() WHERE organization_id=$1 AND movement_id=$2 AND status='OPEN'`,
      [input.organizationId, movement.id],
    );
  } else
    await db.query(
      `INSERT INTO opes.treasury_exceptions(organization_id,exception_type,movement_id,dedupe_key,details) VALUES($1,'UNMATCHED_ONCHAIN_MOVEMENT',$2,$3,jsonb_build_object('transactionHash',$4,'amountAtomic',$5)) ON CONFLICT(organization_id,exception_type,dedupe_key) DO NOTHING`,
      [
        input.organizationId,
        movement.id,
        `${input.chainId}:${input.log.transactionHash.toLowerCase()}:${Number(BigInt(input.log.logIndex))}`,
        input.log.transactionHash.toLowerCase(),
        amount,
      ],
    );
}
async function postControlLedger(db: TenantDatabase, organizationId: string) {
  const actions = await db.query<{
    id: string;
    action_type: string;
    transaction_hash: string;
    payload: { input?: { amountAtomic?: unknown } };
  }>(
    `SELECT action.id,action.action_type,action.transaction_hash,action.payload FROM opes.lifecycle_chain_actions action WHERE action.organization_id=$1 AND action.status='CONFIRMED' AND action.transaction_hash IS NOT NULL AND action.action_type='RECOVER_USDC' AND NOT EXISTS(SELECT 1 FROM opes.ledger_entries ledger WHERE ledger.organization_id=action.organization_id AND ledger.ledger_event_type='USDC_RECOVERED' AND ledger.ledger_event_id=action.id)`,
    [organizationId],
  );
  for (const action of actions.rows) {
    const rawAmount = action.payload.input?.amountAtomic;
    const amount = typeof rawAmount === 'string' ? rawAmount : '0';
    if (!/^\d+$/.test(amount) || amount === '0') continue;
    for (const [line, account, direction] of [
      [1, 'ASSET:RECOVERY_USDC', 'DEBIT'],
      [2, 'ASSET:OPERATING_USDC', 'CREDIT'],
    ] as const)
      await db.query(
        `INSERT INTO opes.ledger_entries(organization_id,ledger_event_type,ledger_event_id,line_number,account,direction,asset_symbol,amount_atomic,source_type,source_id,transaction_hash) VALUES($1,'USDC_RECOVERED',$2,$3,$4,$5,'USDC',$6,'LIFECYCLE_CHAIN_ACTION',$2,$7) ON CONFLICT DO NOTHING`,
        [
          organizationId,
          action.id,
          line,
          account,
          direction,
          amount,
          action.transaction_hash,
        ],
      );
  }
}
async function checkBalances(
  db: TenantDatabase,
  organizationId: string,
  environment: string,
  addresses: string[],
  from: number,
  to: number,
  token: string,
) {
  for (const address of addresses) {
    const data = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    });
    const balance = BigInt(
      await rpc<string>(environment, 'eth_call', [
        { to: token, data },
        hex(to),
      ]),
    );
    const previous = (
      await db.query<{ balance_atomic: string }>(
        `SELECT balance_atomic::text FROM opes.treasury_balance_snapshots WHERE organization_id=$1 AND environment=$2 AND address=$3 AND asset_symbol='USDC' ORDER BY block_number DESC LIMIT 1`,
        [organizationId, environment, address],
      )
    ).rows[0];
    if (previous) {
      const flow = (
        await db.query<{ incoming: string; outgoing: string }>(
          `SELECT COALESCE(sum(amount_atomic) FILTER(WHERE to_address=$4),0)::text AS incoming,COALESCE(sum(amount_atomic) FILTER(WHERE from_address=$4),0)::text AS outgoing FROM opes.chain_movements WHERE organization_id=$1 AND environment=$2 AND status='FINALIZED' AND block_number BETWEEN $3 AND $5`,
          [organizationId, environment, from, address, to],
        )
      ).rows[0];
      const expected =
        BigInt(previous.balance_atomic) +
        BigInt(flow?.incoming ?? '0') -
        BigInt(flow?.outgoing ?? '0');
      if (expected !== balance)
        await db.query(
          `INSERT INTO opes.treasury_exceptions(organization_id,exception_type,dedupe_key,details) VALUES($1,'BALANCE_MISMATCH',$2,jsonb_build_object('address',$3,'expectedAtomic',$4,'observedAtomic',$5,'blockNumber',$6)) ON CONFLICT(organization_id,exception_type,dedupe_key) DO NOTHING`,
          [
            organizationId,
            `${address}:${to}`,
            address,
            expected.toString(),
            balance.toString(),
            to,
          ],
        );
    }
    await db.query(
      `INSERT INTO opes.treasury_balance_snapshots(organization_id,environment,address,asset_symbol,block_number,balance_atomic) VALUES($1,$2,$3,'USDC',$4,$5) ON CONFLICT DO NOTHING`,
      [organizationId, environment, address, to, balance.toString()],
    );
  }
}
async function postSponsorLedger(db: TenantDatabase, organizationId: string) {
  const actions = await db.query<{ id: string; transaction_hash: string }>(
    `SELECT action.id,action.transaction_hash FROM opes.lifecycle_chain_actions action WHERE action.organization_id=$1 AND action.actor='OPERATOR' AND action.status='CONFIRMED' AND action.transaction_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM opes.ledger_entries ledger WHERE ledger.organization_id=action.organization_id AND ledger.ledger_event_type='SPONSOR_GAS_SPENT' AND ledger.ledger_event_id=action.id)`,
    [organizationId],
  );
  for (const action of actions.rows) {
    const receipt = await rpc<{
      gasUsed: string;
      effectiveGasPrice?: string;
    } | null>('arc-testnet', 'eth_getTransactionReceipt', [
      action.transaction_hash,
    ]);
    if (!receipt) continue;
    const amount =
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? '0x0');
    if (amount === 0n) continue;
    for (const [line, account, direction] of [
      [1, 'EXPENSE:SPONSOR_GAS', 'DEBIT'],
      [2, 'EQUITY:SPONSOR_CONTRIBUTION', 'CREDIT'],
    ] as const)
      await db.query(
        `INSERT INTO opes.ledger_entries(organization_id,ledger_event_type,ledger_event_id,line_number,account,direction,asset_symbol,amount_atomic,source_type,source_id,transaction_hash) VALUES($1,'SPONSOR_GAS_SPENT',$2,$3,$4,$5,'ARC_NATIVE',$6,'LIFECYCLE_CHAIN_ACTION',$2,$7) ON CONFLICT DO NOTHING`,
        [
          organizationId,
          action.id,
          line,
          account,
          direction,
          amount.toString(),
          action.transaction_hash,
        ],
      );
  }
}
export function topicAddress(topic: string) {
  return `0x${topic.slice(-40)}`.toLowerCase();
}
export function hex(value: number) {
  return `0x${value.toString(16)}`;
}
async function rpc<T>(
  environment: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const name = `OPES_RPC_${environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const url = process.env[name]?.trim();
  if (!url) throw new Error(`${name} is not configured`);
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
