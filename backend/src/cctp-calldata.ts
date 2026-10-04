import { keccak_256 } from '@noble/hashes/sha3.js';
import { isEvmAddress } from './evm-decision-hash';

export interface CctpDepositForBurnInput {
  amount: string;
  destinationDomain: number;
  mintRecipient: string;
  burnToken: string;
  destinationCaller?: string;
  maxFeeAtomic?: string;
  minFinalityThreshold?: number;
}

const DEPOSIT_FOR_BURN_SELECTOR = selector(
  'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
);
const ZERO_BYTES32 = Buffer.alloc(32);

export function buildCctpDepositForBurnCalldata(
  input: CctpDepositForBurnInput,
): string {
  const destinationCaller = input.destinationCaller ?? null;
  return `0x${Buffer.concat([
    DEPOSIT_FOR_BURN_SELECTOR,
    word(BigInt(input.amount)),
    word(BigInt(input.destinationDomain)),
    addressBytes32(input.mintRecipient),
    addressWord(input.burnToken),
    destinationCaller === null
      ? ZERO_BYTES32
      : addressBytes32(destinationCaller),
    word(BigInt(input.maxFeeAtomic ?? '0')),
    word(BigInt(input.minFinalityThreshold ?? 2000)),
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

function addressBytes32(value: string): Buffer {
  if (!isEvmAddress(value)) {
    throw new Error('ABI address is invalid');
  }
  return Buffer.from(value.slice(2).toLowerCase().padStart(64, '0'), 'hex');
}
