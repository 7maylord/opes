import { ConflictException } from '@nestjs/common';
import { keccak256, stringToHex } from 'viem';
import { addressTopic } from '../../infrastructure/evm/lifecycle-chain-evidence';
import { supportedNetworks } from '../treasury/liquidity-policy';
import { rpc } from '../treasury/treasury-reconciliation.service';

interface Receipt {
  status: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    removed?: boolean;
  }>;
}

export async function verifyRefund(input: {
  environment: string;
  chainId: number;
  transactionHash: string;
  amount: string;
  from: string;
  to: string | null;
}) {
  const network = supportedNetworks().find(
    (item) =>
      item.environment === input.environment && item.chainId === input.chainId,
  );
  if (!network || !input.to || !/^0x[0-9a-fA-F]{40}$/.test(input.to))
    throw new ConflictException('Refund treasury binding is unavailable');
  const [receipt, chainId, head] = await Promise.all([
    rpc<Receipt | null>(input.environment, 'eth_getTransactionReceipt', [
      input.transactionHash,
    ]),
    rpc<string>(input.environment, 'eth_chainId', []),
    rpc<string>(input.environment, 'eth_blockNumber', []),
  ]);
  const finality = Number(
    process.env.OPES_RECONCILIATION_FINALITY_BLOCKS ?? '12',
  );
  if (!Number.isSafeInteger(finality) || finality < 1)
    throw new Error('Refund finality must be a positive block count');
  if (
    !receipt ||
    receipt.status !== '0x1' ||
    receipt.transactionHash.toLowerCase() !==
      input.transactionHash.toLowerCase() ||
    BigInt(chainId) !== BigInt(input.chainId) ||
    !/^0x[0-9a-f]+$/i.test(receipt.blockNumber) ||
    BigInt(head) < BigInt(receipt.blockNumber) + BigInt(finality)
  )
    throw new ConflictException(
      'Refund is not confirmed on the expected chain',
    );
  const block = await rpc<{ hash: string } | null>(
    input.environment,
    'eth_getBlockByNumber',
    [receipt.blockNumber, false],
  );
  if (!block || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new ConflictException('Refund block is no longer canonical');
  const signature = keccak256(stringToHex('Transfer(address,address,uint256)'));
  const amount = receipt.logs
    .filter(
      (log) =>
        !log.removed &&
        log.address.toLowerCase() === network.usdc.toLowerCase() &&
        log.topics.length === 3 &&
        log.topics[0]?.toLowerCase() === signature &&
        log.topics[1]?.toLowerCase() === addressTopic(input.from) &&
        log.topics[2]?.toLowerCase() === addressTopic(input.to!) &&
        /^0x[0-9a-fA-F]{64}$/.test(log.data),
    )
    .reduce((total, log) => total + BigInt(log.data), 0n);
  if (amount !== BigInt(input.amount))
    throw new ConflictException(
      'Refund must return the exact USDC amount from the paid vendor wallet to the original treasury',
    );
  return {
    chainId: input.chainId,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    token: network.usdc,
    from: input.from,
    to: input.to,
    amountAtomic: input.amount,
  };
}
