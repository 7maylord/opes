import {
  buildErc20TransferCalldata,
  buildExecuteDirectPaymentCalldata,
} from './evm-calldata';

describe('EVM calldata helpers', () => {
  it('encodes BusinessPolicyVault.executeDirectPayment calldata', () => {
    expect(
      buildExecuteDirectPaymentCalldata({
        decisionHash:
          '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        obligationKey:
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        contextHash:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        idempotencyKey:
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        vendor: '0x0000000000000000000000000000000000000002',
        amount: '12340001',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toBe(
      '0x7a154aaeddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeecccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccceeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000bc4b210000000000000000000000000000000000000000000000000000000070dbd880',
    );
  });

  it('encodes an exact ERC-20 destination payout', () => {
    expect(
      buildErc20TransferCalldata(
        '0x0000000000000000000000000000000000000002',
        '500000',
      ),
    ).toBe(
      '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000007a120',
    );
  });
});
