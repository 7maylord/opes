import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import {
  LiquidityService,
  TreasuryPositionResponse,
} from './liquidity.service';
import { PaymentCalendarService } from './payment-calendar.service';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'calendar-test',
};

describe('PaymentCalendarService', () => {
  it('projects only unreserved operating obligations', async () => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('payable_obligation_versions'))
        return Promise.resolve({
          rows: [
            {
              id: 'invoice',
              invoice_number: 'INV-1',
              vendor_name: 'Vendor',
              amount_atomic: '10000000',
              due_at: new Date('2030-01-10T00:00:00Z'),
              proposed_execution_at: null,
              derived_action: 'PAY',
              execution_status: null,
              reserved: true,
            },
          ],
        });
      if (sql.includes('FROM opes.subscription_cycles cycle JOIN'))
        return Promise.resolve({
          rows: [
            {
              id: 'cycle',
              subscription_id: 'subscription',
              vendor_name: 'Vendor',
              amount_atomic: '15000000',
              due_at: new Date('2030-01-15T00:00:00Z'),
              status: 'DUE',
            },
          ],
        });
      if (sql.includes('FROM opes.subscriptions'))
        return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [
          {
            id: 'milestone',
            agreement_id: 'agreement',
            vendor_name: 'Vendor',
            title: 'Delivery',
            amount_atomic: '30000000',
            status: 'ACCEPTED',
            accepted_at: new Date('2030-01-20T00:00:00Z'),
          },
        ],
      });
    });
    const database = {
      withTenant: jest.fn(
        (_context: TenantContext, work: (client: TenantDatabase) => unknown) =>
          work({ query } as TenantDatabase),
      ),
    } as unknown as DatabaseService;
    const position = {
      operatingBalanceAtomic: '100000000',
      operatingBufferAtomic: '10000000',
      reservedAtomic: '20000000',
      approvedUnsettledPaymentAtomic: '5000000',
      snapshotStatus: 'FRESH',
    } as TreasuryPositionResponse;
    const liquidity = {
      getTreasuryPosition: jest.fn().mockResolvedValue(position),
    } as unknown as LiquidityService;

    const result = await new PaymentCalendarService(database, liquidity).get(
      context,
      '2030-01-01',
      '2030-03-31',
    );

    expect(result).toMatchObject({
      startingOperatingAvailableAtomic: '65000000',
      scheduledOperatingSpendAtomic: '15000000',
      projectedOperatingAvailableAtomic: '50000000',
      uncoveredAtomic: '0',
    });
    expect(
      result.items.find((item) => item.id === 'invoice:invoice'),
    ).toMatchObject({
      affectsOperatingBalance: false,
      projectedOperatingAvailableAtomic: null,
    });
    expect(
      result.items.find((item) => item.id === 'milestone:milestone'),
    ).toMatchObject({
      affectsOperatingBalance: false,
      projectedOperatingAvailableAtomic: null,
    });
  });
});
