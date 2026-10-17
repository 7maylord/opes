import { AgentDecisionService } from './agent-decision.service';
import { DatabaseService, TenantDatabase } from './database.service';
import { DecisionService } from './decision.service';
import { InvoiceModelService } from './invoice-model.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

describe('AgentDecisionService', () => {
  it('attaches a future payment date to a delayed proposal', async () => {
    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const query: TenantDatabase['query'] = jest.fn().mockResolvedValue({
      rows: [
        {
          invoice_number: 'INV-1',
          amount_atomic: '1000000',
          currency: 'USDC',
          vendor_status: 'VERIFIED',
          address_status: 'VERIFIED_ACTIVE',
          payout_address: '0x0000000000000000000000000000000000000001',
          document_status: 'VERIFIED',
          extraction_output: { dueDate: '2030-01-01' },
          due_at: dueAt,
        },
      ],
    });
    const withTenant = jest.fn(
      (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
        work({ query }),
    );
    const evaluateInvoicePayment = jest.fn().mockResolvedValue({
      id: 'decision-1',
      modelAction: 'DELAY',
      derivedAction: 'DELAY',
    });
    const service = new AgentDecisionService(
      { withTenant } as unknown as DatabaseService,
      {
        proposePayment: jest.fn().mockResolvedValue({
          output: {
            action: 'DELAY',
            rationale: 'Verified and due later',
            confidence: 90,
          },
          model: 'test-model',
          promptVersion: 'invoice-payment-decision-v1',
        }),
      } as unknown as InvoiceModelService,
      { evaluateInvoicePayment } as unknown as DecisionService,
    );
    const input = {
      invoiceVersionId: '55555555-5555-4555-8555-555555555555',
      route: {
        liquidityRoute: 'OPERATING' as const,
        environment: 'arc-testnet',
        chainId: 5042002,
        assetSymbol: 'USDC',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    await expect(
      service.evaluateInvoicePayment(context, input),
    ).resolves.toMatchObject({ derivedAction: 'DELAY' });
    expect(evaluateInvoicePayment).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        modelAction: 'DELAY',
        modelRationale: 'Verified and due later',
        modelName: 'test-model',
        proposedExecutionAt: new Date(
          dueAt.getTime() - 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );
  });
});
