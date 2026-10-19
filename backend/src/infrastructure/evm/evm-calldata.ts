import { keccak_256 } from '@noble/hashes/sha3.js';
import { isEvmAddress } from './evm-decision-hash';

export interface DirectPaymentCalldataInput {
  decisionHash: string;
  obligationKey: string;
  contextHash: string;
  idempotencyKey: string;
  vendor: string;
  amount: string;
  expiresAt: string;
}

const EXECUTE_DIRECT_PAYMENT_SELECTOR = selector(
  'executeDirectPayment(bytes32,bytes32,bytes32,bytes32,address,uint256,uint64)',
);
const TRANSFER_SELECTOR = selector('transfer(address,uint256)');

export function buildErc20TransferCalldata(
  recipient: string,
  amount: string,
): string {
  return `0x${Buffer.concat([
    TRANSFER_SELECTOR,
    addressWord(recipient),
    word(BigInt(amount)),
  ]).toString('hex')}`;
}

export function buildExecuteDirectPaymentCalldata(
  input: DirectPaymentCalldataInput,
): string {
  return `0x${Buffer.concat([
    EXECUTE_DIRECT_PAYMENT_SELECTOR,
    bytes32Word(input.decisionHash),
    bytes32Word(input.obligationKey),
    bytes32Word(input.contextHash),
    bytes32Word(input.idempotencyKey),
    addressWord(input.vendor),
    word(BigInt(input.amount)),
    word(BigInt(Math.floor(Date.parse(input.expiresAt) / 1000))),
  ]).toString('hex')}`;
}

function selector(signature: string): Buffer {
  return Buffer.from(keccak_256(new TextEncoder().encode(signature))).subarray(
    0,
    4,
  );
}

function word(value: bigint): Buffer {
  if (value < 0n) {
    throw new Error('ABI word cannot be negative');
  }
  const text = value.toString(16);
  if (text.length > 64) {
    throw new Error('ABI word exceeds uint256');
  }
  return Buffer.from(text.padStart(64, '0'), 'hex');
}

function addressWord(value: string): Buffer {
  if (!isEvmAddress(value)) {
    throw new Error('ABI address is invalid');
  }
  return Buffer.from(value.slice(2).toLowerCase().padStart(64, '0'), 'hex');
}

function bytes32Word(value: string): Buffer {
  const text = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error('ABI bytes32 is invalid');
  }
  return Buffer.from(text.toLowerCase(), 'hex');
}
