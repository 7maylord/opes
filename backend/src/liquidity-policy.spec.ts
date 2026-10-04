import {
  evaluateLiquidityAction,
  evaluatePaymentRoute,
  supportedNetworks,
} from './liquidity-policy';

describe('liquidity policy', () => {
  const originalBaseUsdt = process.env.OPES_BASE_MAINNET_USDT_ADDRESS;
  const originalBaseSwapProvider =
    process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_PROVIDER;
  const originalBaseSwapRouter =
    process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_ROUTER;

  afterEach(() => {
    if (originalBaseUsdt === undefined) {
      delete process.env.OPES_BASE_MAINNET_USDT_ADDRESS;
    } else {
      process.env.OPES_BASE_MAINNET_USDT_ADDRESS = originalBaseUsdt;
    }
    if (originalBaseSwapProvider === undefined) {
      delete process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_PROVIDER;
    } else {
      process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_PROVIDER =
        originalBaseSwapProvider;
    }
    if (originalBaseSwapRouter === undefined) {
      delete process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_ROUTER;
    } else {
      process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_ROUTER =
        originalBaseSwapRouter;
    }
  });

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
          environment: 'arc-mainnet',
          chainId: 5042001,
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

  it('supports Circle Gateway liquidity from Arc USDC to Base USDC', () => {
    expect(
      evaluateLiquidityAction({
        actionType: 'GATEWAY_TRANSFER',
        source: {
          environment: 'arc-mainnet',
          chainId: 5042001,
          assetSymbol: 'USDC',
        },
        destination: {
          environment: 'base-mainnet',
          chainId: 8453,
          assetSymbol: 'USDC',
        },
      }),
    ).toMatchObject({
      executable: true,
      reason: 'Gateway route is supported',
    });
  });

  it('requires an explicit Base USDC to USDT swap route', () => {
    const route = {
      actionType: 'GATEWAY_TRANSFER' as const,
      source: {
        environment: 'arc-mainnet',
        chainId: 5042001,
        assetSymbol: 'USDC',
      },
      destination: {
        environment: 'base-mainnet',
        chainId: 8453,
        assetSymbol: 'USDT',
      },
    };

    expect(evaluateLiquidityAction(route)).toMatchObject({
      executable: false,
      reason: 'Base USDC to USDT swap route is not configured',
    });

    process.env.OPES_BASE_MAINNET_USDT_ADDRESS =
      '0x0000000000000000000000000000000000000003';
    process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_PROVIDER = 'configured';
    process.env.OPES_BASE_MAINNET_USDC_USDT_SWAP_ROUTER =
      '0x0000000000000000000000000000000000000004';

    expect(evaluateLiquidityAction(route)).toMatchObject({
      executable: true,
      reason: 'Gateway route with Base USDT swap is supported',
    });
  });

  it('rejects token conversion and Celo CCTP until a provider is selected', () => {
    expect(
      evaluateLiquidityAction({
        actionType: 'CCTP_TRANSFER',
        source: {
          environment: 'arc-mainnet',
          chainId: 5042001,
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
      reason: 'CCTP moves USDC only; token conversion is separate',
    });
    expect(
      evaluateLiquidityAction({
        actionType: 'CCTP_TRANSFER',
        source: {
          environment: 'arc-mainnet',
          chainId: 5042001,
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

  it('keeps all required chain environments visible with current Circle domains', () => {
    const networks = supportedNetworks();
    expect(networks).toHaveLength(12);
    expect(networks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ environment: 'arc-testnet', cctpDomain: 26 }),
        expect.objectContaining({ environment: 'arc-mainnet', gateway: true }),
        expect.objectContaining({ environment: 'base-mainnet', gateway: true }),
        expect.objectContaining({
          environment: 'monad-testnet',
          cctpDomain: 15,
        }),
        expect.objectContaining({
          environment: 'celo-sepolia',
          cctpDomain: null,
        }),
      ]),
    );
  });
});
