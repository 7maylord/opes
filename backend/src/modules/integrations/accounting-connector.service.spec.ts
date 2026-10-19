import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AccountingConnectorService } from './accounting-connector.service';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

const context: TenantContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  membershipId: '00000000-0000-4000-8000-000000000003',
  agentId: '00000000-0000-4000-8000-000000000004',
  role: 'OWNER',
  requestId: 'request-1',
};

function serviceWithQuery(query: TenantDatabase['query']) {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new AccountingConnectorService({
    withTenant,
  } as unknown as DatabaseService);
}

describe('AccountingConnectorService', () => {
  beforeEach(() => {
    process.env.OPES_CONNECTOR_ENCRYPTION_KEY = '12'.repeat(32);
  });

  it('stores encrypted connector credentials and queues the first sync', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = jest.fn((text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO opes.accounting_connector_bindings')) {
        return Promise.resolve({
          rows: [
            {
              id: values?.[0],
              organization_id: context.organizationId,
              provider: 'ERPNEXT',
              label: 'Finance',
              base_url: 'https://erp.example',
              database_name: null,
              encrypted_credentials: values?.[6],
              status: 'ACTIVE',
              sync_cursor: null,
              last_synced_at: null,
              last_error: null,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as unknown as TenantDatabase['query'];

    const created = await serviceWithQuery(query).create(context, {
      provider: 'ERPNEXT',
      label: 'Finance',
      baseUrl: 'https://erp.example/',
      credentials: { apiKey: 'api-key', apiSecret: 'api-secret' },
    });

    expect(created.baseUrl).toBe('https://erp.example');
    const encrypted = String(queries[0].values?.[6]);
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('api-secret');
    expect(
      queries.some((item) =>
        item.text.includes('INSERT INTO opes.outbox_events'),
      ),
    ).toBe(true);
  });

  it('allows only owners and admins to configure connectors', async () => {
    const service = serviceWithQuery(jest.fn());
    await expect(
      service.create(
        { ...context, role: 'AUDITOR' },
        {
          provider: 'ODOO',
          label: 'Odoo',
          baseUrl: 'https://odoo.example',
          credentials: { apiKey: 'key' },
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('disconnects a tenant connector and cancels pending sync work', async () => {
    const queries: string[] = [];
    const query = jest.fn((text: string) => {
      queries.push(text);
      return Promise.resolve({
        rows: text.includes('UPDATE opes.accounting_connector_bindings')
          ? [{ id: '00000000-0000-4000-8000-000000000005' }]
          : [],
        rowCount: 1,
      });
    }) as unknown as TenantDatabase['query'];

    await expect(
      serviceWithQuery(query).disconnect(
        context,
        '00000000-0000-4000-8000-000000000005',
      ),
    ).resolves.toEqual({ disconnected: true });
    expect(queries.some((text) => text.includes("status='DISABLED'"))).toBe(
      true,
    );
    expect(
      queries.some((text) => text.includes('Connector disconnected')),
    ).toBe(true);
  });

  it('rejects writeback without both imported bill and settlement ledger evidence', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const service = serviceWithQuery(query);
    await expect(
      service.requestSettlementWriteback(
        context,
        '00000000-0000-4000-8000-000000000005',
        {
          paymentExecutionId: '00000000-0000-4000-8000-000000000006',
          externalBillId: 'PINV-1',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
