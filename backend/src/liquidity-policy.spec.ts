import {
  evaluateLiquidityAction,
  evaluatePaymentRoute,
  supportedNetworks,
} from './liquidity-policy';

describe('liquidity policy', () => {
  it('keeps same-chain Arc USDC as the only executable vendor payment route', () => {
    expect(
      evaluatePaymentRoute({
        liquidityRoute: 'OPERATING',
        environment: 'arc-testnet',
        chainId: 5042002,
        assetSymbol: 'USDC',
      }),
    ).toMatchObject({ executable: true });
    expect(
      evaluatePaymentRoute({
        liquidityRoute: 'CCTP',
        environment: 'base-mainnet',
        chainId: 8453,
        assetSymbol: 'USDC',
      }),
    ).toMatchObject({
      executable: false,
      reason: 'CCTP liquidity is planned separately from vendor payment',
    });
  });

  it('supports CCTP liquidity between known USDC chains', () => {
    expect(
      evaluateLiquidityAction({
        actionType: 'CCTP_TRANSFER',
        source: {
          environment: 'base-mainnet',
          chainId: 8453,
          assetSymbol: 'USDC',
        },
        destination: {
          environment: 'arbitrum-mainnet',
          chainId: 42161,
          assetSymbol: 'USDC',
        },
      }),
    ).toMatchObject({ executable: true });
  });

  it('rejects token conversion and Celo CCTP until a provider is selected', () => {
    expect(
      evaluateLiquidityAction({
        actionType: 'CCTP_TRANSFER',
        source: {
          environment: 'base-mainnet',
          chainId: 8453,
          assetSymbol: 'USDC',
        },
        destination: {
          environment: 'arbitrum-mainnet',
          chainId: 42161,
          assetSymbol: 'USDT',
        },
      }),
    ).toMatchObject({
      executable: false,
      reason: 'liquidity actions move USDC only; token conversion is separate',
    });
    expect(
      evaluateLiquidityAction({
        actionType: 'CCTP_TRANSFER',
        source: {
          environment: 'base-mainnet',
          chainId: 8453,
          assetSymbol: 'USDC',
        },
        destination: {
          environment: 'celo-mainnet',
          chainId: 42220,
          assetSymbol: 'USDC',
        },
      }),
    ).toMatchObject({
      executable: false,
      reason: 'CCTP is unavailable for one or both chains',
    });
  });

  it('keeps all required chain environments visible', () => {
    expect(supportedNetworks()).toHaveLength(12);
  });
});
