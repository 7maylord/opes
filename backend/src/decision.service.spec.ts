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

function treasuryRow() {
  return {
    configured: true,
    operating_buffer_atomic: '1000000',
    monthly_budget_atomic: '5000000000',
    max_snapshot_age_seconds: 300,
    binding_count: '1',
    environment_count: '1',
    snapshot_count: '1',
    verified_balance_atomic: '5000000000',
    restricted_balance_atomic: '0',
    snapshot_observed_at: new Date(),
    read_count: '1',
    failed_read_count: '0',
    committed_payables_atomic: '0',
    approved_unsettled_atomic: '0',
    reserved_atomic: '0',
    monthly_settled_atomic: '0',
    planned_incoming_atomic: '0',
    in_transit_atomic: '0',
    forecast_30_atomic: '0',
    forecast_90_atomic: '0',
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
            metadata: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ organization_id: context.organizationId }],
      })
      .mockResolvedValueOnce({ rows: [treasuryRow()] })
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
              decision_hash: values[17],
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
        }),
      );
    query.mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    const decision = await service.evaluateInvoicePayment(context, request);

    expect(decision.derivedAction).toBe('PAY');
    expect(decision.decisionVersion).toBe(1);
    expect(decision.decisionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(query).toHaveBeenNthCalledWith(
      7,
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
        rows: [
          { id: 'binding-1', address: '0x1', status: 'ACTIVE', metadata: {} },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ organization_id: context.organizationId }],
      })
      .mockResolvedValueOnce({ rows: [treasuryRow()] })
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
              decision_hash: values[17],
              checks: JSON.parse(
                values[18] as string,
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
        rows: [
          {
            id: 'binding-1',
            address: '0x0000000000000000000000000000000000000003',
            status: 'ACTIVE',
            metadata: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ organization_id: context.organizationId }],
      })
      .mockResolvedValueOnce({ rows: [treasuryRow()] })
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
              decision_hash: values[17],
              checks: JSON.parse(
                values[18] as string,
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

describe('DecisionService approvals', () => {
  it('binds approval to the exact stored decision fields', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '55555555-5555-5555-5555-555555555555',
            source_type: 'INVOICE',
            source_id: '66666666-6666-6666-6666-666666666666',
            source_version_id: request.invoiceVersionId,
            decision_version: 2,
            payment_mode: 'DIRECT',
            model_action: 'PAY',
            derived_action: 'ESCALATE',
            liquidity_route: 'OPERATING',
            route_environment: 'arc-testnet',
            route_chain_id: 5042002,
            route_asset_symbol: 'USDC',
            amount_atomic: '1000000001',
            destination_address: '0x0000000000000000000000000000000000000002',
            evidence_bundle_hash: 'c'.repeat(64),
            policy_snapshot_hash: 'd'.repeat(64),
            context_hash: 'e'.repeat(64),
            decision_hash: null,
            checks: [
              {
                code: 'autonomous_amount_limit',
                status: 'REQUIRES_APPROVAL',
                message: 'amount requires approval',
              },
            ],
            expires_at: expiresAt,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'approval-1',
            decision_id: '55555555-5555-5555-5555-555555555555',
            decision_version: 2,
            source_version_id: request.invoiceVersionId,
            amount_atomic: '1000000001',
            destination_address: '0x0000000000000000000000000000000000000002',
            context_hash: 'e'.repeat(64),
            policy_snapshot_hash: 'd'.repeat(64),
            status: 'ACTIVE',
            expires_at: expiresAt,
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(
      service.approveDecision(context, '55555555-5555-5555-5555-555555555555'),
    ).resolves.toMatchObject({
      decisionVersion: 2,
      amountAtomic: '1000000001',
      contextHash: 'e'.repeat(64),
      status: 'ACTIVE',
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO opes.payment_decision_approvals'),
      expect.arrayContaining([
        '55555555-5555-5555-5555-555555555555',
        2,
        request.invoiceVersionId,
        '1000000001',
        '0x0000000000000000000000000000000000000002',
        'e'.repeat(64),
        'd'.repeat(64),
      ]),
    );
  });

  it('does not approve blocked decisions', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: '55555555-5555-5555-5555-555555555555',
          source_type: 'INVOICE',
          source_id: '66666666-6666-6666-6666-666666666666',
          source_version_id: request.invoiceVersionId,
          decision_version: 1,
          payment_mode: 'DIRECT',
          model_action: 'PAY',
          derived_action: 'REJECT',
          liquidity_route: 'CCTP',
          route_environment: 'base-mainnet',
          route_chain_id: 8453,
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
              status: 'BLOCK',
              message: 'route unsupported',
            },
          ],
          expires_at: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.approveDecision(context, '55555555-5555-5555-5555-555555555555'),
    ).rejects.toThrow('Rejected decisions cannot be approved');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
