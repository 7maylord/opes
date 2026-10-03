import { BadRequestException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { LifecycleService } from './lifecycle.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

function serviceWithQuery(query: TenantDatabase['query']): LifecycleService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new LifecycleService({ withTenant } as unknown as DatabaseService);
}

function verifiedPayeeMocks(query: jest.Mock): jest.Mock {
  return query
    .mockResolvedValueOnce({ rows: [{ id: 'vendor-1', status: 'VERIFIED' }] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'address-1',
          vendor_id: '55555555-5555-5555-5555-555555555555',
          status: 'VERIFIED_ACTIVE',
          asset_symbol: 'USDC',
        },
      ],
    });
}

describe('LifecycleService', () => {
  it('creates a monthly subscription cycle with month-end leap clamping', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'subscription-1', status: 'ACTIVE' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'version-1',
            version: 1,
            cadence: 'MONTHLY',
            anchor_date: '2028-01-31',
            timezone: 'America/New_York',
            amount_atomic: '300000000',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'cycle-1',
            subscription_id: 'subscription-1',
            subscription_version_id: 'version-1',
            service_period_start: '2028-01-31',
            service_period_end: '2028-02-29',
            due_at: new Date('2028-01-31T12:00:00.000Z'),
            amount_atomic: '300000000',
            status: 'DUE',
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(
      service.createSubscriptionCycle(
        context,
        '55555555-5555-5555-5555-555555555555',
        {
          servicePeriodStart: '2028-01-31',
        },
      ),
    ).resolves.toMatchObject({
      servicePeriodStart: '2028-01-31',
      servicePeriodEnd: '2028-02-29',
      dueAt: '2028-01-31T12:00:00.000Z',
      amountAtomic: '300000000',
      status: 'DUE',
    });
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        'ON CONFLICT (organization_id, subscription_id, service_period_start, service_period_end)',
      ),
      expect.arrayContaining(['2028-01-31', '2028-02-29']),
    );
  });

  it('rejects escrow milestones whose amounts do not equal the agreement total', async () => {
    const service = serviceWithQuery(jest.fn());

    await expect(
      service.createEscrowAgreement(context, {
        vendorId: '55555555-5555-5555-5555-555555555555',
        vendorAddressId: '66666666-6666-6666-6666-666666666666',
        totalAmount: '10.00',
        milestones: [
          { title: 'Design', amount: '4.00' },
          { title: 'Build', amount: '5.00' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates an escrow agreement with bounded milestones', async () => {
    const query = verifiedPayeeMocks(jest.fn())
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agreement-1',
            status: 'ACTIVE',
            total_amount_atomic: '10000000',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'milestone-1',
            agreement_id: 'agreement-1',
            milestone_index: 0,
            title: 'Design',
            amount_atomic: '4000000',
            status: 'PENDING',
            evidence_document_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'milestone-2',
            agreement_id: 'agreement-1',
            milestone_index: 1,
            title: 'Build',
            amount_atomic: '6000000',
            status: 'PENDING',
            evidence_document_id: null,
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(
      service.createEscrowAgreement(context, {
        vendorId: '55555555-5555-5555-5555-555555555555',
        vendorAddressId: '66666666-6666-6666-6666-666666666666',
        totalAmount: '10.00',
        milestones: [
          { title: 'Design', amount: '4.00' },
          { title: 'Build', amount: '6.00' },
        ],
      }),
    ).resolves.toMatchObject({
      totalAmountAtomic: '10000000',
      milestones: [
        { milestoneIndex: 0, amountAtomic: '4000000', status: 'PENDING' },
        { milestoneIndex: 1, amountAtomic: '6000000', status: 'PENDING' },
      ],
    });
  });

  it('accepts only submitted milestone evidence', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'milestone-1',
          agreement_id: 'agreement-1',
          milestone_index: 0,
          title: 'Design',
          amount_atomic: '4000000',
          status: 'ACCEPTED',
          evidence_document_id: '77777777-7777-7777-7777-777777777777',
        },
      ],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.acceptMilestone(context, '55555555-5555-5555-5555-555555555555'),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("AND status = 'SUBMITTED'"),
      [
        context.organizationId,
        '55555555-5555-5555-5555-555555555555',
        context.membershipId,
      ],
    );
  });
});
