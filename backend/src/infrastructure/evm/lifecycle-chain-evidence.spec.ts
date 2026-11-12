import { keccak256, stringToHex } from 'viem';
import {
  addressTopic,
  LifecycleExecutionEvidence,
  verifyLifecycleExecution,
} from './lifecycle-chain-evidence';

const wallet = '0x0000000000000000000000000000000000000001';
const vault = '0x0000000000000000000000000000000000000002';
const vendor = '0x0000000000000000000000000000000000000003';
const token = '0x3600000000000000000000000000000000000000';
const txHash = `0x${'a'.repeat(64)}`;
const mandate = `0x${'b'.repeat(64)}`;
const obligation = `0x${'c'.repeat(64)}`;

function topic(signature: string) {
  return keccak256(stringToHex(signature));
}

function amount(value: bigint) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

describe('verifyLifecycleExecution', () => {
  const expected: LifecycleExecutionEvidence = {
    walletId: 'circle-wallet-1',
    walletAddress: wallet,
    contractAddress: vault,
    callData: '0x1234',
    tokenAddress: token,
    transferFrom: vault,
    transferTo: vendor,
    amountAtomic: '1000000',
    eventAddress: vault,
    eventSignature: 'RecurringPaymentExecuted(bytes32,bytes32,uint256)',
    eventTopics: [mandate, obligation],
  };
  const circle = {
    state: 'COMPLETE',
    blockchain: 'ARC-TESTNET',
    walletId: expected.walletId,
    sourceAddress: wallet,
    contractAddress: vault,
    txHash,
  };
  const transaction = { from: wallet, to: vault, input: expected.callData };
  const receipt = {
    status: '0x1',
    transactionHash: txHash,
    logs: [
      {
        address: vault,
        topics: [topic(expected.eventSignature), mandate, obligation],
        data: amount(1_000_000n),
      },
      {
        address: token,
        topics: [
          topic('Transfer(address,address,uint256)'),
          addressTopic(vault),
          addressTopic(vendor),
        ],
        data: amount(1_000_000n),
      },
    ],
  };

  it('requires matching Circle, Arc event, and exact USDC transfer evidence', () => {
    expect(
      verifyLifecycleExecution(expected, circle, transaction, receipt),
    ).toBe(txHash);
    expect(() =>
      verifyLifecycleExecution(expected, circle, transaction, {
        ...receipt,
        logs: receipt.logs.map((log, index) =>
          index === 1 ? { ...log, data: amount(999_999n) } : log,
        ),
      }),
    ).toThrow('Lifecycle USDC transfer evidence mismatch');
  });
});
