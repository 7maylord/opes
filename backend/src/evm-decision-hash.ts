import { keccak_256 } from '@noble/hashes/sha3.js';

const ZERO_BYTES32 = '0x' + '0'.repeat(64);

export interface DirectPaymentDecisionHashInput {
  chainId: number;
  vault: string;
  organizationDomain: string;
  token: string;
  obligationKey: string;
  vendor: string;
  amount: string;
  expiresAt: string;
  contextHash: string;
}

export function organizationDomain(
  organizationId: string,
  environment: string,
): string {
  return hex(
    keccak_256(
      new TextEncoder().encode(
        `opes:${environment}:${organizationId.toLowerCase()}`,
      ),
    ),
  );
}

export function buildDirectPaymentDecisionHash(
  input: DirectPaymentDecisionHashInput,
): string {
  return hex(
    keccak_256(
      Buffer.concat([
        word(1n),
        word(BigInt(input.chainId)),
        addressWord(input.vault),
        bytes32Word(input.organizationDomain),
        addressWord(input.token),
        word(1n),
        bytes32Word(input.obligationKey),
        addressWord(input.vendor),
        word(BigInt(input.amount)),
        word(BigInt(Math.floor(Date.parse(input.expiresAt) / 1000))),
        bytes32Word(ZERO_BYTES32),
        bytes32Word(ZERO_BYTES32),
        word(0n),
        bytes32Word(input.contextHash),
      ]),
    ),
  );
}

export function isEvmAddress(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
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

function hex(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString('hex')}`;
}
