import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { LiquidityService } from './liquidity.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

const request = {
  actionType: 'CCTP_TRANSFER' as const,
  idempotencyKey: 'a'.repeat(64),
  source: {
    environment: 'arc-testnet',
    chainId: 5042002,
    assetSymbol: 'USDC',
  },
  destination: {
    environment: 'base-sepolia',
    chainId: 84532,
    assetSymbol: 'USDC',
  },
  amountAtomic: '25000000',
  quoteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

const gatewayRequest = {
  actionType: 'GATEWAY_TRANSFER' as const,
  idempotencyKey: 'c'.repeat(64),
  source: {
    environment: 'arc-testnet',
    chainId: 5042002,
    assetSymbol: 'USDC',
  },
  destination: {
    environment: 'base-sepolia',
    chainId: 84532,
    assetSymbol: 'USDC',
  },
  amountAtomic: '25000000',
  quoteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function serviceWithQuery(query: TenantDatabase['query']): LiquidityService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new LiquidityService({ withTenant } as unknown as DatabaseService);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    action_type: 'CCTP_TRANSFER',
    idempotency_key: request.idempotencyKey,
    request_hash: 'b'.repeat(64),
    provider: 'sandbox',
    simulated: true,
    status: 'PLANNED',
    source_environment: 'arc-testnet',
    source_chain_id: 5042002,
    source_asset_symbol: 'USDC',
    destination_environment: 'base-sepolia',
    destination_chain_id: 84532,
    destination_asset_symbol: 'USDC',
    amount_atomic: '25000000',
    fee_atomic: '0',
    quote_expires_at: new Date(request.quoteExpiresAt),
    provider_reference: 'sim_abc',
    provider_payload: {},
    failure_reason: null,
    ...overrides,
  };
}

describe('LiquidityService', () => {
  const originalSandbox = process.env.OPES_LIQUIDITY_SANDBOX;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.OPES_ALLOWED_ORIGINS;
  const originalCircleApiKey = process.env.CIRCLE_API_KEY;
  const originalCircleEntitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const originalGatewayApiUrl = process.env.OPES_GATEWAY_API_URL;
  const originalBaseUsdt = process.env.OPES_BASE_SEPOLIA_USDT_ADDRESS;
  const originalBaseSwapProvider =
    process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_PROVIDER;
  const originalBaseSwapRouter =
    process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_ROUTER;

  afterEach(() => {
    if (originalSandbox === undefined) {
      delete process.env.OPES_LIQUIDITY_SANDBOX;
    } else {
      process.env.OPES_LIQUIDITY_SANDBOX = originalSandbox;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalAllowedOrigins === undefined) {
      delete process.env.OPES_ALLOWED_ORIGINS;
    } else {
      process.env.OPES_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
    if (originalCircleApiKey === undefined) {
      delete process.env.CIRCLE_API_KEY;
    } else {
      process.env.CIRCLE_API_KEY = originalCircleApiKey;
    }
    if (originalCircleEntitySecret === undefined) {
      delete process.env.CIRCLE_ENTITY_SECRET;
    } else {
      process.env.CIRCLE_ENTITY_SECRET = originalCircleEntitySecret;
    }
    if (originalGatewayApiUrl === undefined) {
      delete process.env.OPES_GATEWAY_API_URL;
    } else {
      process.env.OPES_GATEWAY_API_URL = originalGatewayApiUrl;
    }
    if (originalBaseUsdt === undefined) {
      delete process.env.OPES_BASE_SEPOLIA_USDT_ADDRESS;
    } else {
      process.env.OPES_BASE_SEPOLIA_USDT_ADDRESS = originalBaseUsdt;
    }
    if (originalBaseSwapProvider === undefined) {
      delete process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_PROVIDER;
    } else {
      process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_PROVIDER =
        originalBaseSwapProvider;
    }
    if (originalBaseSwapRouter === undefined) {
      delete process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_ROUTER;
    } else {
      process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_ROUTER =
        originalBaseSwapRouter;
    }
  });

  it('versions policy and invalidates authorizations bound to older policy', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ max_snapshot_age_seconds: 300 }] })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '55555555-5555-5555-5555-555555555555',
            version: 2,
            status: 'ACTIVE',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    await expect(
      service.configurePaymentPolicy(context, {
        autonomousLimitAtomic: '1000000000',
        singlePaymentLimitAtomic: '10000000000',
        vendorDailyLimitAtomic: '25000000000',
        organizationDailyLimitAtomic: '100000000000',
        monthlyBudgetAtomic: '5000000000',
        operatingBufferAtomic: '100000000',
        allowedRoutes: [
          {
            liquidityRoute: 'OPERATING',
            environment: 'arc-testnet',
            chainId: 5042002,
            assetSymbol: 'USDC',
          },
        ],
        allowedAssets: ['USDC'],
      }),
    ).resolves.toMatchObject({ version: 2, status: 'ACTIVE' });
    expect(query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("status='REVOKED'"),
      [context.organizationId, '55555555-5555-5555-5555-555555555555'],
    );
    expect(query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining("status='RELEASED'"),
      [context.organizationId, '55555555-5555-5555-5555-555555555555'],
    );
  });

  it('plans a deterministic sandbox CCTP liquidity action once', async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPES_LIQUIDITY_SANDBOX = 'true';
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ address: '0x0000000000000000000000000000000000000001' }],
      })
      .mockResolvedValueOnce({
        rows: [{ address: '0x0000000000000000000000000000000000000002' }],
      })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            row({
              request_hash: values[3],
              provider_reference: values[14],
              provider_payload: JSON.parse(values[15] as string),
            }),
          ],
        }),
      )
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    await expect(
      service.planLiquidityAction(context, request),
    ).resolves.toMatchObject({
      actionType: 'CCTP_TRANSFER',
      provider: 'sandbox',
      simulated: true,
      status: 'PLANNED',
      source: { chainId: 5042002 },
      destination: { chainId: 84532 },
      feeAtomic: '0',
    });
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO opes.liquidity_actions'),
      expect.arrayContaining([
        context.organizationId,
        'CCTP_TRANSFER',
        request.idempotencyKey,
        'sandbox',
        true,
        'arc-testnet',
        5042002,
        'USDC',
        'base-sepolia',
        84532,
        'USDC',
        '25000000',
      ]),
    );
  });

  it('reuses the existing action for the same idempotency key and request', async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPES_LIQUIDITY_SANDBOX = 'true';
    let requestHash = '';
    const firstService = serviceWithQuery(
      jest.fn((text: string, values?: readonly unknown[]) => {
        if (text.includes('SELECT') && text.includes('liquidity_actions')) {
          return Promise.resolve({ rows: [] });
        }
        if (text.includes('SELECT address')) {
          return Promise.resolve({
            rows: [{ address: '0x0000000000000000000000000000000000000001' }],
          });
        }
        if (text.includes('INSERT INTO opes.liquidity_actions')) {
          requestHash = values?.[3] as string;
          return Promise.resolve({
            rows: [row({ request_hash: requestHash })],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    );
    await firstService.planLiquidityAction(context, request);

    const query = jest.fn().mockResolvedValueOnce({
      rows: [row({ request_hash: requestHash })],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.planLiquidityAction(context, request),
    ).resolves.toMatchObject({
      idempotencyKey: request.idempotencyKey,
      status: 'PLANNED',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported token conversion routes before insert', async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPES_LIQUIDITY_SANDBOX = 'true';
    const query = jest.fn();
    const service = serviceWithQuery(query);

    await expect(
      service.planLiquidityAction(context, {
        ...request,
        destination: { ...request.destination, assetSymbol: 'USDT' },
      }),
    ).rejects.toThrow(ConflictException);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not use sandbox liquidity in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPES_ALLOWED_ORIGINS = 'https://opes.example';
    process.env.OPES_LIQUIDITY_SANDBOX = 'true';
    const query = jest.fn();
    const service = serviceWithQuery(query);

    await expect(service.planLiquidityAction(context, request)).rejects.toThrow(
      'Circle wallets are not configured',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('prepares a live CCTP action in production when Circle is configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPES_ALLOWED_ORIGINS = 'https://opes.example';
    process.env.CIRCLE_API_KEY = 'test-key';
    process.env.CIRCLE_ENTITY_SECRET = 'test-secret';
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000001',
            resource_id: 'arc-wallet-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000002',
            resource_id: 'arb-wallet-1',
          },
        ],
      })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            row({
              provider: values[4],
              simulated: values[5],
              request_hash: values[3],
              provider_reference: values[14],
              provider_payload: JSON.parse(values[15] as string),
            }),
          ],
        }),
      )
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    const action = await service.planLiquidityAction(context, request);

    expect(action).toMatchObject({
      provider: 'cctp-v2',
      simulated: false,
      providerReference: null,
    });
    expect(action.providerPayload.provider).toBe('cctp-v2');
    expect(action.providerPayload.source).toMatchObject({
      messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    });
  });

  it('prepares a live Gateway action from Arc USDC to Base USDC', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPES_ALLOWED_ORIGINS = 'https://opes.example';
    process.env.CIRCLE_API_KEY = 'test-key';
    process.env.CIRCLE_ENTITY_SECRET = 'test-secret';
    process.env.OPES_GATEWAY_API_URL = 'https://gateway.example.test/transfer';
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000001',
            resource_id: 'arc-wallet-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000002',
            resource_id: 'base-wallet-1',
          },
        ],
      })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            row({
              action_type: 'GATEWAY_TRANSFER',
              idempotency_key: gatewayRequest.idempotencyKey,
              source_environment: 'arc-testnet',
              source_chain_id: 5042002,
              source_asset_symbol: 'USDC',
              destination_environment: 'base-sepolia',
              destination_chain_id: 84532,
              destination_asset_symbol: 'USDC',
              provider: values[4],
              simulated: values[5],
              request_hash: values[3],
              provider_reference: values[14],
              provider_payload: JSON.parse(values[15] as string),
            }),
          ],
        }),
      )
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    const action = await service.planLiquidityAction(context, gatewayRequest);

    expect(action).toMatchObject({
      actionType: 'GATEWAY_TRANSFER',
      provider: 'circle-gateway',
      simulated: false,
      source: { environment: 'arc-testnet' },
      destination: { environment: 'base-sepolia', assetSymbol: 'USDC' },
    });
    expect(action.providerPayload).toMatchObject({
      provider: 'circle-gateway',
      gatewayRequest: {
        action: 'transferUnifiedUsdc',
        gatewayApiUrl: 'https://gateway.example.test/transfer',
        sourceChainId: 5042002,
        destinationChainId: 84532,
      },
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO opes.outbox_events'),
      expect.arrayContaining([
        context.organizationId,
        'action-1',
        'liquidity.execute.gateway',
      ]),
    );
  });

  it('adds the configured Base USDC to USDT swap leg to Gateway actions', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPES_ALLOWED_ORIGINS = 'https://opes.example';
    process.env.CIRCLE_API_KEY = 'test-key';
    process.env.CIRCLE_ENTITY_SECRET = 'test-secret';
    process.env.OPES_BASE_SEPOLIA_USDT_ADDRESS =
      '0x0000000000000000000000000000000000000003';
    process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_PROVIDER = 'configured';
    process.env.OPES_BASE_SEPOLIA_USDC_USDT_SWAP_ROUTER =
      '0x0000000000000000000000000000000000000004';
    const usdtGatewayRequest = {
      ...gatewayRequest,
      idempotencyKey: 'd'.repeat(64),
      destination: { ...gatewayRequest.destination, assetSymbol: 'USDT' },
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000001',
            resource_id: 'arc-wallet-1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            address: '0x0000000000000000000000000000000000000002',
            resource_id: 'base-wallet-1',
          },
        ],
      })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            row({
              action_type: 'GATEWAY_TRANSFER',
              idempotency_key: usdtGatewayRequest.idempotencyKey,
              destination_environment: 'base-sepolia',
              destination_chain_id: 84532,
              destination_asset_symbol: 'USDT',
              provider: values[4],
              simulated: values[5],
              request_hash: values[3],
              provider_payload: JSON.parse(values[15] as string),
            }),
          ],
        }),
      )
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    const action = await service.planLiquidityAction(
      context,
      usdtGatewayRequest,
    );

    expect(action.destination.assetSymbol).toBe('USDT');
    expect(action.providerPayload.destinationSwap).toMatchObject({
      provider: 'configured',
      inputAssetSymbol: 'USDC',
      outputAssetSymbol: 'USDT',
      outputToken: '0x0000000000000000000000000000000000000003',
    });
    const gatewayRequestPayload = action.providerPayload
      .gatewayRequest as Record<string, unknown>;
    expect(gatewayRequestPayload.destinationSwap).toMatchObject({
      outputAssetSymbol: 'USDT',
    });
  });

  it('requires an approving role to plan liquidity', async () => {
    const service = serviceWithQuery(jest.fn());

    await expect(
      service.planLiquidityAction({ ...context, role: 'AUDITOR' }, request),
    ).rejects.toThrow(ForbiddenException);
  });
});
