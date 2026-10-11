export type LiquidityRoute = 'OPERATING' | 'GATEWAY' | 'CCTP' | 'NONE';

export interface ChainRoutePoint {
  environment: string;
  chainId: number;
  assetSymbol: string;
}

export interface CctpNetworkContracts {
  usdc: string;
  tokenMessengerV2: string;
  messageTransmitterV2: string;
}

export interface GatewayNetworkContracts {
  usdc: string;
  gatewayWallet: string;
  gatewayMinter: string;
}

export interface BaseSwapRoute {
  provider: string;
  router: string;
  inputToken: string;
  outputToken: string;
  minimumOutputBps: number;
  inputAssetSymbol: 'USDC';
  outputAssetSymbol: 'USDT';
}

export interface RouteCapabilityResult {
  supported: boolean;
  executable: boolean;
  reason: string;
}

export interface NetworkCapability {
  environment: string;
  chainId: number;
  family: string;
  tier: 'mainnet' | 'testnet';
  cctpDomain: number | null;
  cctpContracts: CctpNetworkContracts | null;
  gatewayContracts: GatewayNetworkContracts | null;
  gateway: boolean;
}

const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const TOKEN_MESSENGER_V2_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const MESSAGE_TRANSMITTER_V2_TESTNET =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';

const GATEWAY_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
const GATEWAY_MINTER = '0x2222222d7164433c4C09B0b0D809a9b52C04C205';
const GATEWAY_WALLET_TESTNET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const GATEWAY_MINTER_TESTNET = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

const NETWORKS: NetworkCapability[] = [
  cctpNetwork(
    'arbitrum-mainnet',
    42161,
    'arbitrum',
    'mainnet',
    3,
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ),
  cctpNetwork(
    'arbitrum-sepolia',
    421614,
    'arbitrum',
    'testnet',
    3,
    '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  ),
  cctpNetwork(
    'base-mainnet',
    8453,
    'base',
    'mainnet',
    6,
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    true,
  ),
  cctpNetwork(
    'base-sepolia',
    84532,
    'base',
    'testnet',
    6,
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    true,
  ),
  cctpNetwork(
    'arc-mainnet',
    5042001,
    'arc',
    'mainnet',
    26,
    '0x3600000000000000000000000000000000000000',
    true,
  ),
  cctpNetwork(
    'arc-testnet',
    5042002,
    'arc',
    'testnet',
    26,
    '0x3600000000000000000000000000000000000000',
    true,
  ),
  usdcOnlyNetwork('celo-mainnet', 42220, 'celo', 'mainnet'),
  usdcOnlyNetwork('celo-sepolia', 11142220, 'celo', 'testnet'),
  cctpNetwork(
    'ethereum-mainnet',
    1,
    'ethereum',
    'mainnet',
    0,
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  ),
  cctpNetwork(
    'ethereum-sepolia',
    11155111,
    'ethereum',
    'testnet',
    0,
    '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  ),
  cctpNetwork(
    'monad-mainnet',
    143,
    'monad',
    'mainnet',
    15,
    '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  ),
  cctpNetwork(
    'monad-testnet',
    10143,
    'monad',
    'testnet',
    15,
    '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  ),
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
    if (
      route.environment === 'base-sepolia' &&
      route.chainId === 84532 &&
      normalizeAsset(route.assetSymbol) === 'USDC'
    )
      return {
        supported: true,
        executable: true,
        reason: 'CCTP-funded Base Sepolia payout is supported',
      };
    return {
      supported: false,
      executable: false,
      reason: 'CCTP liquidity is planned separately from vendor payment',
    };
  }

  if (route.liquidityRoute === 'GATEWAY') {
    if (
      route.environment === 'base-sepolia' &&
      route.chainId === 84532 &&
      normalizeAsset(route.assetSymbol) === 'USDC'
    )
      return {
        supported: true,
        executable: true,
        reason: 'Gateway-funded Base Sepolia payout is supported',
      };
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
  if (normalizeAsset(input.source.assetSymbol) !== 'USDC') {
    return {
      supported: false,
      executable: false,
      reason: 'liquidity actions must start from USDC',
    };
  }

  if (input.actionType === 'CCTP_TRANSFER') {
    if (normalizeAsset(input.destination.assetSymbol) !== 'USDC') {
      return {
        supported: false,
        executable: false,
        reason: 'CCTP moves USDC only; token conversion is separate',
      };
    }
    if (source.family !== 'arc') {
      return {
        supported: false,
        executable: false,
        reason: 'Arc is the configured source wallet for CCTP liquidity',
      };
    }
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

  if (
    source.family !== 'arc' ||
    destination.family !== 'base' ||
    !source.gateway ||
    !destination.gateway
  ) {
    return {
      supported: false,
      executable: false,
      reason: 'Gateway route is enabled only for Arc to Base USDC liquidity',
    };
  }
  if (normalizeAsset(input.destination.assetSymbol) === 'USDT') {
    if (baseUsdcToUsdtSwapRouteDetails(input.destination) === null) {
      return {
        supported: true,
        executable: false,
        reason: 'Base USDC to USDT swap route is not configured',
      };
    }
    return {
      supported: true,
      executable: true,
      reason: 'Gateway route with Base USDT swap is supported',
    };
  }
  if (normalizeAsset(input.destination.assetSymbol) !== 'USDC') {
    return {
      supported: false,
      executable: false,
      reason:
        'Gateway can deliver USDC; only configured Base USDT swaps are supported',
    };
  }
  return {
    supported: true,
    executable: true,
    reason: 'Gateway route is supported',
  };
}

export function supportedNetworks(): NetworkCapability[] {
  return NETWORKS.map((item) => ({
    ...item,
    cctpContracts:
      item.cctpContracts === null ? null : { ...item.cctpContracts },
    gatewayContracts:
      item.gatewayContracts === null ? null : { ...item.gatewayContracts },
  }));
}

export function cctpRouteDetails(input: {
  source: ChainRoutePoint;
  destination: ChainRoutePoint;
}): { source: NetworkCapability; destination: NetworkCapability } | null {
  const source = findNetwork(input.source);
  const destination = findNetwork(input.destination);
  if (source === undefined || destination === undefined) {
    return null;
  }
  if (source.cctpContracts === null || destination.cctpContracts === null) {
    return null;
  }
  return { source, destination };
}

export function gatewayRouteDetails(input: {
  source: ChainRoutePoint;
  destination: ChainRoutePoint;
}): { source: NetworkCapability; destination: NetworkCapability } | null {
  const source = findNetwork(input.source);
  const destination = findNetwork(input.destination);
  if (source === undefined || destination === undefined) {
    return null;
  }
  if (
    source.gatewayContracts === null ||
    destination.gatewayContracts === null
  ) {
    return null;
  }
  return { source, destination };
}

export function baseUsdcToUsdtSwapRouteDetails(
  destination: ChainRoutePoint,
): BaseSwapRoute | null {
  const network = findNetwork(destination);
  if (
    network === undefined ||
    network.family !== 'base' ||
    normalizeAsset(destination.assetSymbol) !== 'USDT'
  ) {
    return null;
  }
  const prefix = `OPES_${network.environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const provider = process.env[`${prefix}_USDC_USDT_SWAP_PROVIDER`]?.trim();
  const router = process.env[`${prefix}_USDC_USDT_SWAP_ROUTER`]?.trim();
  const outputToken = process.env[`${prefix}_USDT_ADDRESS`]?.trim();
  const minimumOutputBps = parseMinimumOutputBps(
    process.env[`${prefix}_USDC_USDT_MIN_OUTPUT_BPS`],
  );
  const inputToken = network.cctpContracts?.usdc;
  if (
    provider === undefined ||
    provider === '' ||
    !isAddress(router) ||
    !isAddress(outputToken) ||
    minimumOutputBps === null ||
    inputToken === undefined
  ) {
    return null;
  }
  return {
    provider,
    router,
    inputToken,
    outputToken,
    minimumOutputBps,
    inputAssetSymbol: 'USDC',
    outputAssetSymbol: 'USDT',
  };
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

function cctpNetwork(
  environment: string,
  chainId: number,
  family: string,
  tier: 'mainnet' | 'testnet',
  cctpDomain: number,
  usdc: string,
  gateway = false,
): NetworkCapability {
  const gatewayContracts = gateway
    ? {
        usdc,
        gatewayWallet:
          tier === 'mainnet' ? GATEWAY_WALLET : GATEWAY_WALLET_TESTNET,
        gatewayMinter:
          tier === 'mainnet' ? GATEWAY_MINTER : GATEWAY_MINTER_TESTNET,
      }
    : null;
  return {
    environment,
    chainId,
    family,
    tier,
    cctpDomain,
    cctpContracts: {
      usdc,
      tokenMessengerV2:
        tier === 'mainnet' ? TOKEN_MESSENGER_V2 : TOKEN_MESSENGER_V2_TESTNET,
      messageTransmitterV2:
        tier === 'mainnet'
          ? MESSAGE_TRANSMITTER_V2
          : MESSAGE_TRANSMITTER_V2_TESTNET,
    },
    gatewayContracts,
    gateway,
  };
}

function usdcOnlyNetwork(
  environment: string,
  chainId: number,
  family: string,
  tier: 'mainnet' | 'testnet',
): NetworkCapability {
  return {
    environment,
    chainId,
    family,
    tier,
    cctpDomain: null,
    cctpContracts: null,
    gatewayContracts: null,
    gateway: false,
  };
}

function isAddress(value: string | undefined): value is string {
  return value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseMinimumOutputBps(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return 9900;
  }
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) {
    return null;
  }
  return bps;
}
