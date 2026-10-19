import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

function serviceWithQuery(
  query: TenantDatabase['query'],
): PaymentReconciliationService {
  const withOrganizationScope = jest.fn(
    (_organizationId: string, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new PaymentReconciliationService({
    withOrganizationScope,
  } as unknown as DatabaseService);
}

function signature(payload: unknown, secret: string): string {
  const payloadHash = hashStable(payload);
  return `sha256=${createHash('sha256')
    .update(`${payloadHash}:${secret}`)
    .digest('hex')}`;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

describe('PaymentReconciliationService', () => {
  const originalSecret = process.env.OPES_PAYMENT_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.OPES_PAYMENT_WEBHOOK_SECRET;
    } else {
      process.env.OPES_PAYMENT_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('records a signed notification without using it as settlement proof', async () => {
    process.env.OPES_PAYMENT_WEBHOOK_SECRET = 'secret-1';
    const payload = {
      executionId: '55555555-5555-5555-5555-555555555555',
      transactionHash: `0x${'a'.repeat(64)}`,
      status: 'CONFIRMED' as const,
      chainId: 5042002,
      to: '0x0000000000000000000000000000000000000003',
      callData: '0x7a154aae',
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'event-1', status: 'RECORDED', duplicate: false }],
      });
    const service = serviceWithQuery(query);

    await expect(
      service.recordWebhook({
        organizationId: '11111111-1111-1111-1111-111111111111',
        provider: 'opes-internal',
        externalEventId: 'evt-1',
        signature: signature(payload, 'secret-1'),
        payload,
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'RECORDED', duplicate: false });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'CONFIRMED'"),
      expect.anything(),
    );
  });

  it('deduplicates provider event ids', async () => {
    process.env.OPES_PAYMENT_WEBHOOK_SECRET = 'secret-1';
    const payload = { status: 'SUBMITTED' as const };
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ id: 'event-1', status: 'RECORDED', duplicate: true }],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.recordWebhook({
        organizationId: '11111111-1111-1111-1111-111111111111',
        provider: 'circle',
        externalEventId: 'evt-1',
        signature: signature(payload, 'secret-1'),
        payload,
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'RECORDED', duplicate: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects unsigned webhooks before writing', async () => {
    delete process.env.OPES_PAYMENT_WEBHOOK_SECRET;
    const query = jest.fn();
    const service = serviceWithQuery(query);

    await expect(
      service.recordWebhook({
        organizationId: '11111111-1111-1111-1111-111111111111',
        provider: 'circle',
        externalEventId: 'evt-1',
        signature: 'bad',
        payload: { status: 'SUBMITTED' },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});
