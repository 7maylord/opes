import { keccak256, stringToHex } from 'viem';

export interface CircleLifecycleTransaction {
  state: string;
  blockchain: string;
  walletId?: string;
  sourceAddress?: string;
  contractAddress?: string;
  txHash?: string;
  errorReason?: string;
  errorDetails?: string;
}

export const TERMINAL_CIRCLE_STATES = new Set([
  'FAILED',
  'DENIED',
  'CANCELLED',
]);

export interface LifecycleRpcTransaction {
  from: string;
  to: string | null;
  input: string;
}

export interface LifecycleRpcReceipt {
  status: string;
  transactionHash: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface LifecycleExecutionEvidence {
  walletId: string;
  walletAddress: string;
  contractAddress: string;
  callData: string;
  tokenAddress: string;
  transferFrom: string;
  transferTo: string;
  amountAtomic: string;
  eventAddress: string;
  eventSignature: string;
  eventTopics: string[];
}

const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)');

export function verifyLifecycleExecution(
  expected: LifecycleExecutionEvidence,
  circle: CircleLifecycleTransaction,
  transaction: LifecycleRpcTransaction,
  receipt: LifecycleRpcReceipt,
): string {
  const transactionHash = requireTransactionHash(circle.txHash);
  if (
    circle.blockchain !== 'ARC-TESTNET' ||
    circle.walletId !== expected.walletId ||
    circle.sourceAddress?.toLowerCase() !==
      expected.walletAddress.toLowerCase() ||
    circle.contractAddress?.toLowerCase() !==
      expected.contractAddress.toLowerCase()
  )
    throw new Error('Circle transaction does not match the lifecycle action');
  if (
    receipt.status !== '0x1' ||
    receipt.transactionHash.toLowerCase() !== transactionHash ||
    transaction.from.toLowerCase() !== expected.walletAddress.toLowerCase() ||
    transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() ||
    transaction.input.toLowerCase() !== expected.callData.toLowerCase()
  )
    throw new Error('Lifecycle transaction evidence mismatch');

  const topics = [eventTopic(expected.eventSignature), ...expected.eventTopics];
  const event = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === expected.eventAddress.toLowerCase() &&
      log.topics.length === topics.length &&
      topics.every(
        (topic, index) =>
          log.topics[index]?.toLowerCase() === topic.toLowerCase(),
      ) &&
      decodeAmount(log.data) === BigInt(expected.amountAtomic),
  );
  if (!event) throw new Error('Lifecycle contract event evidence mismatch');

  const transfer = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === expected.tokenAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      log.topics[1]?.toLowerCase() === addressTopic(expected.transferFrom) &&
      log.topics[2]?.toLowerCase() === addressTopic(expected.transferTo) &&
      decodeAmount(log.data) === BigInt(expected.amountAtomic),
  );
  if (!transfer) throw new Error('Lifecycle USDC transfer evidence mismatch');
  return transactionHash;
}

export function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function uintTopic(value: number): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function eventTopic(signature: string): string {
  return keccak256(stringToHex(signature));
}

function decodeAmount(value: string): bigint | undefined {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? BigInt(value) : undefined;
}

function requireTransactionHash(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Circle returned an invalid transaction hash');
  return value.toLowerCase();
}
