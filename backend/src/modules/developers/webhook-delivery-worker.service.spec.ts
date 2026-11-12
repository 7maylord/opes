import { createHmac } from 'node:crypto';
import { encryptConnectorCredentials } from '../integrations/connector-credentials';
import { WebhookDeliveryWorkerService } from './webhook-delivery-worker.service';
import { postWebhook } from './webhook-request';
jest.mock('./webhook-request', () => ({ postWebhook: jest.fn() }));

it('decrypts with the endpoint identity and sends a verifiable signature under the delivery claim', async () => {
  const previous = process.env.OPES_CONNECTOR_ENCRYPTION_KEY;
  process.env.OPES_CONNECTOR_ENCRYPTION_KEY = 'a'.repeat(64);
  try {
    const work = {
      id: 'delivery',
      endpoint_id: 'endpoint',
      organization_id: 'org',
      claim_token: 'claim',
      event_id: 'event',
      event_type: 'PAYMENT_SETTLED',
      created_at: new Date(),
      payload: { amount: '10' },
      url: 'https://receiver.example/events',
      signing_secret_encrypted: encryptConnectorCredentials('org', 'endpoint', {
        secret: 'test-secret',
      }),
    };
    const query = jest.fn((sql: string) =>
      Promise.resolve({
        rows: sql.includes('WITH candidate AS') ? [work] : [],
      }),
    );
    jest.mocked(postWebhook).mockResolvedValue({ status: 200, body: 'ok' });
    const service = new WebhookDeliveryWorkerService({
      withWorker: (fn: (db: unknown) => unknown) => fn({ query }),
    } as never);
    await service.processDue(1);
    const [, body, headers] = jest.mocked(postWebhook).mock.calls[0];
    expect(headers['x-opes-signature']).toBe(
      `v1=${createHmac('sha256', 'test-secret').update(`${headers['x-opes-timestamp']}.${body}`).digest('hex')}`,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status='DELIVERED'"),
      ['delivery', 200, 'ok', 'claim'],
    );
  } finally {
    if (previous === undefined)
      delete process.env.OPES_CONNECTOR_ENCRYPTION_KEY;
    else process.env.OPES_CONNECTOR_ENCRYPTION_KEY = previous;
  }
});
