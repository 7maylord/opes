import { DatabaseService, TenantDatabase } from './database.service';
import { DecisionService } from './decision.service';
import type { DecisionCheckResponse } from './decision.service';
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
  invoiceVersionId: '55555555-5555-5555-5555-555555555555',
  modelAction: 'PAY' as const,
  modelName: 'fixture-model',
  modelRationale: 'invoice is valid',
  promptVersion: 'b6-test',
  route: {
    liquidityRoute: 'OPERATING' as const,
    environment: 'arc-testnet',
    chainId: 5042002,
    assetSymbol: 'USDC',
  },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function serviceWithQuery(query: TenantDatabase['query']): DecisionService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new DecisionService({ withTenant } as unknown as DatabaseService);
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: request.invoiceVersionId,
    obligation_id: '66666666-6666-6666-6666-666666666666',
    vendor_id: '77777777-7777-7777-7777-777777777777',
    vendor_address_id: '88888888-8888-8888-8888-888888888888',
    evidence_document_id: '99999999-9999-9999-9999-999999999999',
    extraction_id: null,
    invoice_number: 'INV-1042',
    currency: 'USDC',
    amount_atomic: '12340001',
    amount_decimals: 6,
    content_hash: 'a'.repeat(64),
    obligation_key: 'b'.repeat(64),
    vendor_status: 'VERIFIED',
    vendor_version: 1,
    address_status: 'VERIFIED_ACTIVE',
    payout_address: '0x0000000000000000000000000000000000000002',
    address_version: 1,
    ...overrides,
  };
}

describe('DecisionService', () => {
  it('creates a payable invoice decision when deterministic checks pass', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [invoiceRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'binding-1',
            address: '0x0000000000000000000000000000000000000003',
            status: 'ACTIVE',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ next_version: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'decision-1',
            source_type: 'INVOICE',
            source_id: '66666666-6666-6666-6666-666666666666',
            source_version_id: request.invoiceVersionId,
            decision_version: 1,
            payment_mode: 'DIRECT',
            model_action: 'PAY',
            derived_action: 'PAY',
            liquidity_route: 'OPERATING',
            route_environment: 'arc-testnet',
            route_chain_id: 5042002,
            route_asset_symbol: 'USDC',
            amount_atomic: '12340001',
            destination_address: '0x0000000000000000000000000000000000000002',
            evidence_bundle_hash: 'c'.repeat(64),
            policy_snapshot_hash: 'd'.repeat(64),
            context_hash: 'e'.repeat(64),
            decision_hash: null,
            checks: [
              {
                code: 'route_supported',
                status: 'PASS',
                message: 'route is supported',
              },
            ],
            expires_at: new Date(request.expiresAt),
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(
      service.evaluateInvoicePayment(context, request),
    ).resolves.toMatchObject({
      derivedAction: 'PAY',
      decisionVersion: 1,
      decisionHash: null,
    });
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO opes.payment_decisions'),
      expect.arrayContaining([
        'PAY',
        'PAY',
        'OPERATING',
        'arc-testnet',
        5042002,
        'USDC',
      ]),
    );
  });

  it('fails unsupported routes closed even when the model proposes pay', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [invoiceRow()] })
      .mockResolvedValueOnce({
        rows: [{ id: 'binding-1', address: '0x1', status: 'ACTIVE' }],
      })
      .mockResolvedValueOnce({ rows: [{ next_version: 1 }] })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            {
              id: 'decision-1',
              source_type: 'INVOICE',
              source_id: '66666666-6666-6666-6666-666666666666',
              source_version_id: request.invoiceVersionId,
              decision_version: 1,
              payment_mode: 'DIRECT',
              model_action: 'PAY',
              derived_action: values[5],
              liquidity_route: values[6],
              route_environment: values[7],
              route_chain_id: values[8],
              route_asset_symbol: values[9],
              amount_atomic: '12340001',
              destination_address: '0x0000000000000000000000000000000000000002',
              evidence_bundle_hash: 'c'.repeat(64),
              policy_snapshot_hash: 'd'.repeat(64),
              context_hash: 'e'.repeat(64),
              decision_hash: null,
              checks: JSON.parse(
                values[17] as string,
              ) as DecisionCheckResponse[],
              expires_at: new Date(request.expiresAt),
            },
          ],
        }),
      );
    const service = serviceWithQuery(query);

    const decision = await service.evaluateInvoicePayment(context, {
      ...request,
      route: { ...request.route, environment: 'base-mainnet', chainId: 8453 },
    });

    expect(decision.derivedAction).toBe('REJECT');
    expect(decision.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'route_supported', status: 'BLOCK' }),
      ]),
    );
  });

  it('escalates decisions over the autonomous amount limit', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [invoiceRow({ amount_atomic: '1000000001' })],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'binding-1', address: '0x1', status: 'ACTIVE' }],
      })
      .mockResolvedValueOnce({ rows: [{ next_version: 1 }] })
      .mockImplementationOnce((_text: string, values: readonly unknown[]) =>
        Promise.resolve({
          rows: [
            {
              id: 'decision-1',
              source_type: 'INVOICE',
              source_id: '66666666-6666-6666-6666-666666666666',
              source_version_id: request.invoiceVersionId,
              decision_version: 1,
              payment_mode: 'DIRECT',
              model_action: 'PAY',
              derived_action: values[5],
              liquidity_route: values[6],
              route_environment: values[7],
              route_chain_id: values[8],
              route_asset_symbol: values[9],
              amount_atomic: '1000000001',
              destination_address: '0x0000000000000000000000000000000000000002',
              evidence_bundle_hash: 'c'.repeat(64),
              policy_snapshot_hash: 'd'.repeat(64),
              context_hash: 'e'.repeat(64),
              decision_hash: null,
              checks: JSON.parse(
                values[17] as string,
              ) as DecisionCheckResponse[],
              expires_at: new Date(request.expiresAt),
            },
          ],
        }),
      );
    const service = serviceWithQuery(query);

    const decision = await service.evaluateInvoicePayment(context, request);

    expect(decision.derivedAction).toBe('ESCALATE');
    expect(decision.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'autonomous_amount_limit',
          status: 'REQUIRES_APPROVAL',
        }),
      ]),
    );
  });
});
