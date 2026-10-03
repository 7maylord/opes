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
    environment: 'base-mainnet',
    chainId: 8453,
    assetSymbol: 'USDC',
  },
  destination: {
    environment: 'arbitrum-mainnet',
    chainId: 42161,
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
    source_environment: 'base-mainnet',
    source_chain_id: 8453,
    source_asset_symbol: 'USDC',
    destination_environment: 'arbitrum-mainnet',
    destination_chain_id: 42161,
    destination_asset_symbol: 'USDC',
    amount_atomic: '25000000',
    fee_atomic: '0',
    quote_expires_at: new Date(request.quoteExpiresAt),
    provider_reference: 'sim_abc',
    failure_reason: null,
    ...overrides,
  };
}

describe('LiquidityService', () => {
  const originalSandbox = process.env.OPES_LIQUIDITY_SANDBOX;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.OPES_ALLOWED_ORIGINS;

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
  });

  it('plans a deterministic sandbox CCTP liquidity action once', async () => {
    process.env.NODE_ENV = 'test';
    process.env.OPES_LIQUIDITY_SANDBOX = 'true';
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            row({
              request_hash: values[3],
              provider_reference: values[12],
            }),
          ],
        }),
      );
    const service = serviceWithQuery(query);

    await expect(
      service.planLiquidityAction(context, request),
    ).resolves.toMatchObject({
      actionType: 'CCTP_TRANSFER',
      provider: 'sandbox',
      simulated: true,
      status: 'PLANNED',
      source: { chainId: 8453 },
      destination: { chainId: 42161 },
      feeAtomic: '0',
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO opes.liquidity_actions'),
      expect.arrayContaining([
        context.organizationId,
        'CCTP_TRANSFER',
        request.idempotencyKey,
        'base-mainnet',
        8453,
        'USDC',
        'arbitrum-mainnet',
        42161,
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
      jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockImplementationOnce((_text: string, values: readonly unknown[]) => {
          requestHash = values[3] as string;
          return Promise.resolve({
            rows: [row({ request_hash: requestHash })],
          });
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
      'Liquidity provider adapter is not configured',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an approving role to plan liquidity', async () => {
    const service = serviceWithQuery(jest.fn());

    await expect(
      service.planLiquidityAction({ ...context, role: 'AUDITOR' }, request),
    ).rejects.toThrow(ForbiddenException);
  });
});
