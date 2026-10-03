export type LiquidityRoute = 'OPERATING' | 'GATEWAY' | 'CCTP' | 'NONE';

export interface ChainRoutePoint {
  environment: string;
  chainId: number;
  assetSymbol: string;
}

export interface RouteCapabilityResult {
  supported: boolean;
  executable: boolean;
  reason: string;
}

interface NetworkCapability {
  environment: string;
  chainId: number;
  family: string;
  tier: 'mainnet' | 'testnet';
  cctpDomain: number | null;
  gateway: boolean;
}

const NETWORKS: NetworkCapability[] = [
  network('arbitrum-mainnet', 42161, 'arbitrum', 'mainnet', 3, false),
  network('arbitrum-sepolia', 421614, 'arbitrum', 'testnet', 3, false),
  network('base-mainnet', 8453, 'base', 'mainnet', 6, false),
  network('base-sepolia', 84532, 'base', 'testnet', 6, false),
  network('arc-mainnet', 5042001, 'arc', 'mainnet', 12, false),
  network('arc-testnet', 5042002, 'arc', 'testnet', 12, false),
  network('celo-mainnet', 42220, 'celo', 'mainnet', null, false),
  network('celo-sepolia', 11142220, 'celo', 'testnet', null, false),
  network('ethereum-mainnet', 1, 'ethereum', 'mainnet', 0, false),
  network('ethereum-sepolia', 11155111, 'ethereum', 'testnet', 0, false),
  network('monad-mainnet', 143, 'monad', 'mainnet', 11, false),
  network('monad-testnet', 10143, 'monad', 'testnet', 11, false),
];

export function evaluatePaymentRoute(route: {
  liquidityRoute: LiquidityRoute;
  environment: string;
  chainId: number;
  assetSymbol: string;
}): RouteCapabilityResult {
  if (
    route.liquidityRoute === 'OPERATING' &&
    route.environment === 'arc-testnet' &&
    route.chainId === 5042002 &&
    normalizeAsset(route.assetSymbol) === 'USDC'
  ) {
    return { supported: true, executable: true, reason: 'route is supported' };
  }

  if (route.liquidityRoute === 'CCTP') {
    return {
      supported: false,
      executable: false,
      reason: 'CCTP liquidity is planned separately from vendor payment',
    };
  }

  if (route.liquidityRoute === 'GATEWAY') {
    return {
      supported: false,
      executable: false,
      reason: 'Gateway liquidity is planned separately from vendor payment',
    };
  }

  return {
    supported: false,
    executable: false,
    reason: 'route is unsupported',
  };
}

export function evaluateLiquidityAction(input: {
  actionType: 'GATEWAY_TRANSFER' | 'CCTP_TRANSFER';
  source: ChainRoutePoint;
  destination: ChainRoutePoint;
}): RouteCapabilityResult {
  const source = findNetwork(input.source);
  const destination = findNetwork(input.destination);
  if (source === undefined || destination === undefined) {
    return {
      supported: false,
      executable: false,
      reason: 'unknown chain route',
    };
  }
  if (source.tier !== destination.tier) {
    return {
      supported: false,
      executable: false,
      reason: 'mainnet and testnet routes cannot be mixed',
    };
  }
  if (source.chainId === destination.chainId) {
    return {
      supported: false,
      executable: false,
      reason: 'same-chain liquidity transfer is not a crosschain action',
    };
  }
  if (
    normalizeAsset(input.source.assetSymbol) !== 'USDC' ||
    normalizeAsset(input.destination.assetSymbol) !== 'USDC'
  ) {
    return {
      supported: false,
      executable: false,
      reason: 'liquidity actions move USDC only; token conversion is separate',
    };
  }

  if (input.actionType === 'CCTP_TRANSFER') {
    if (source.cctpDomain === null || destination.cctpDomain === null) {
      return {
        supported: false,
        executable: false,
        reason: 'CCTP is unavailable for one or both chains',
      };
    }
    return {
      supported: true,
      executable: true,
      reason: 'CCTP route is supported',
    };
  }

  if (!source.gateway || !destination.gateway) {
    return {
      supported: false,
      executable: false,
      reason: 'Gateway route is not enabled for these chains',
    };
  }
  return {
    supported: true,
    executable: true,
    reason: 'Gateway route is supported',
  };
}

export function supportedNetworks(): NetworkCapability[] {
  return NETWORKS.map((item) => ({ ...item }));
}

function findNetwork(point: ChainRoutePoint): NetworkCapability | undefined {
  return NETWORKS.find(
    (item) =>
      item.environment === point.environment && item.chainId === point.chainId,
  );
}

function normalizeAsset(asset: string): string {
  return asset.trim().toUpperCase();
}

function network(
  environment: string,
  chainId: number,
  family: string,
  tier: 'mainnet' | 'testnet',
  cctpDomain: number | null,
  gateway: boolean,
): NetworkCapability {
  return { environment, chainId, family, tier, cctpDomain, gateway };
}
