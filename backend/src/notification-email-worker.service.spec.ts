import { DatabaseService, TenantDatabase } from './database.service';
import { NotificationEmailWorkerService } from './notification-email-worker.service';

function result(rows: Array<Record<string, unknown>>) {
  return Promise.resolve({
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  });
}

it('sends supplier advice only for a confirmed settlement and records the provider id', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPES_RESEND_API_KEY;
  const originalFrom = process.env.OPES_RESEND_FROM_EMAIL;
  process.env.OPES_RESEND_API_KEY = 're_test';
  process.env.OPES_RESEND_FROM_EMAIL = 'OPES <payments@example.com>';
  const queries: string[] = [];
  const query = jest.fn((text: string) => {
    queries.push(text);
    if (text.includes('WITH candidate AS'))
      return result([
        {
          event_id: 'event-1',
          organization_id: 'org-1',
          delivery_id: 'delivery-1',
          attempts: 0,
        },
      ]);
    if (text.includes('SELECT delivery.recipient_email'))
      return result([
        {
          recipient_email: 'vendor@example.com',
          organization_name: 'Alpha Co',
          vendor_name: 'Canteen Supplies',
          invoice_number: 'INV-100',
          amount_atomic: '1250000',
          asset_symbol: 'USDC',
          route_environment: 'arc-testnet',
          route_chain_id: 5042002,
          transaction_hash: `0x${'a'.repeat(64)}`,
          confirmed_at: new Date('2026-10-16T10:00:00.000Z'),
        },
      ]);
    return result([]);
  });
  let sentBody = '';
  global.fetch = jest.fn((_input, init) => {
    sentBody = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 'resend-1' }),
    } as Response);
  });
  const service = new NotificationEmailWorkerService({
    withWorker: (work: (database: TenantDatabase) => Promise<unknown>) =>
      work({ query }),
  } as unknown as DatabaseService);

  await expect(service.processDue(1)).resolves.toBe(1);
  expect(global.fetch).toHaveBeenCalledWith(
    'https://api.resend.com/emails',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(sentBody).toContain('vendor@example.com');
  expect(queries.some((text) => text.includes("status='SENT'"))).toBe(true);

  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPES_RESEND_API_KEY;
  else process.env.OPES_RESEND_API_KEY = originalKey;
  if (originalFrom === undefined) delete process.env.OPES_RESEND_FROM_EMAIL;
  else process.env.OPES_RESEND_FROM_EMAIL = originalFrom;
});
