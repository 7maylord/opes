import { createHmac } from 'node:crypto';
import {
  DeveloperPlatformService,
  enqueueWebhookEvent,
  signWebhook,
} from './developer-platform.service';

describe('developer platform', () => {
  it('signs the exact timestamp and body delivered to consumers', () => {
    const body = '{"id":"event-1"}';
    expect(signWebhook('secret', '1700000000', body)).toBe(
      createHmac('sha256', 'secret').update(`1700000000.${body}`).digest('hex'),
    );
  });
  it('uses endpoint and event keys to suppress replayed deliveries', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await enqueueWebhookEvent(
      { query } as never,
      '11111111-1111-4111-8111-111111111111',
      'PAYMENT_SETTLED',
      'payment:1',
      { id: '1' },
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT(endpoint_id,event_key) DO NOTHING'),
      expect.any(Array),
    );
  });
  it('returns a new API secret once and stores only its hash', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: '22222222-2222-4222-8222-222222222222' }],
    });
    const service = new DeveloperPlatformService({
      withTenant: (_context: unknown, work: (db: unknown) => unknown) =>
        work({ query }),
    } as never);
    const created = await service.createCredential(
      {
        organizationId: '11111111-1111-4111-8111-111111111111',
        membershipId: '33333333-3333-4333-8333-333333333333',
        role: 'OWNER',
      } as never,
      { name: 'ERP', scopes: ['invoices:read'] },
    );
    expect(created.secret).toMatch(/^opes_/);
    expect(query).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([created.secret]),
    );
  });
});
