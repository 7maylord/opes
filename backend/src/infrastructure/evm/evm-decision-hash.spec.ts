import {
  buildDirectPaymentDecisionHash,
  organizationDomain,
} from './evm-decision-hash';

describe('EVM decision hash helpers', () => {
  it('matches Solidity abi.encode keccak256 for direct payments', () => {
    expect(
      buildDirectPaymentDecisionHash({
        chainId: 5042002,
        vault: '0x0000000000000000000000000000000000000003',
        organizationDomain: organizationDomain(
          '11111111-1111-1111-1111-111111111111',
          'arc-testnet',
        ),
        token: '0x3600000000000000000000000000000000000000',
        obligationKey:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        vendor: '0x0000000000000000000000000000000000000002',
        amount: '12340001',
        expiresAt: '2030-01-01T00:00:00.000Z',
        contextHash:
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      }),
    ).toBe(
      '0xd3a8da84f826476a3c1a5064546818ea8760cf3e5ffd60f1093425584400a1bf',
    );
  });
});
