import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import { ExceptionCenterService } from './exception-center.service';

describe('ExceptionCenterService', () => {
  it('summarizes tenant-scoped exceptions without offering unsafe retries', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          category: 'PAYMENT',
          severity: 'CRITICAL',
          status: 'UNKNOWN',
          title: 'Payment execution needs attention',
          reason: 'Provider result is unknown',
          recommendation: 'Reconcile before retrying.',
          recovery_mode: 'AUTO_RECOVERING',
          action_view: 'invoices',
          action_label: 'Open invoice',
          subject_type: 'payment_execution',
          subject_id: '11111111-1111-1111-1111-111111111111',
          related_record_id: '22222222-2222-2222-2222-222222222222',
          updated_at: new Date('2030-01-01T00:00:00.000Z'),
        },
      ],
    });
    const withTenant = jest.fn(
      (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
        work({ query }),
    );
    const service = new ExceptionCenterService({
      withTenant,
    } as unknown as DatabaseService);
    const context = {
      organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    } as TenantContext;

    await expect(service.list(context)).resolves.toMatchObject({
      summary: { total: 1, critical: 1, userAction: 0, autoRecovering: 1 },
      items: [
        {
          category: 'PAYMENT',
          recoveryMode: 'AUTO_RECOVERING',
          relatedRecordId: '22222222-2222-2222-2222-222222222222',
          updatedAt: '2030-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('opes.treasury_exceptions'),
      [context.organizationId],
    );
  });
});
