import { DatabaseService, TenantDatabase } from './database.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';

function serviceWithWorker(query: TenantDatabase['query']): {
  service: PaymentExecutionWorkerService;
  withWorker: jest.Mock;
} {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return {
    service: new PaymentExecutionWorkerService({
      withWorker,
    } as unknown as DatabaseService),
    withWorker,
  };
}

function workRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'execution-1',
    organization_id: 'organization-1',
    decision_hash: `0x${'d'.repeat(64)}`,
    idempotency_key: 'e'.repeat(64),
    context_hash: 'c'.repeat(64),
    amount_atomic: '12340001',
    destination_address: '0x0000000000000000000000000000000000000002',
    route_chain_id: 5042002,
    vault_address: '0x0000000000000000000000000000000000000003',
    expires_at: new Date('2030-01-01T00:00:00.000Z'),
    wallet_address: '0x0000000000000000000000000000000000000004',
    ...overrides,
  };
}

function queryResult(rows: Array<Record<string, unknown>>) {
  return Promise.resolve({
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  });
}

function recordingQuery(
  queries: Array<{ text: string; values?: readonly unknown[] }>,
  work: Record<string, unknown> | null,
): jest.Mock {
  return jest.fn((text: string, values?: readonly unknown[]) => {
    queries.push({ text, values });

    if (text.includes('RETURNING id, organization_id, aggregate_id')) {
      return queryResult([
        {
          id: 'event-1',
          organization_id: 'organization-1',
          aggregate_id: 'execution-1',
        },
      ]);
    }
    if (text.includes('UPDATE opes.payment_executions AS execution')) {
      return queryResult(work === null ? [] : [work]);
    }
    if (
      text.includes('SELECT id') &&
      text.includes('opes.payment_executions')
    ) {
      return queryResult([{ id: 'execution-1' }]);
    }
    if (text.includes('INSERT INTO opes.payment_execution_attempts')) {
      return queryResult([{ id: 'attempt-1' }]);
    }

    return queryResult([]);
  });
}

describe('PaymentExecutionWorkerService', () => {
  const originalEnv = process.env.OPES_PAYMENT_SIGNER_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPES_PAYMENT_SIGNER_URL;
    } else {
      process.env.OPES_PAYMENT_SIGNER_URL = originalEnv;
    }
    global.fetch = originalFetch;
  });

  it('fails visibly when the tenant operator wallet is missing', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = recordingQuery(queries, null);
    const { service } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.values?.includes('Active operator wallet binding is missing'),
      ),
    ).toBe(true);
  });

  it('records a prepared attempt before failing when signer is unconfigured', async () => {
    delete process.env.OPES_PAYMENT_SIGNER_URL;
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = recordingQuery(queries, workRow());
    const { service } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.text.includes('INSERT INTO opes.payment_execution_attempts'),
      ),
    ).toBe(true);
    expect(
      queries.some((item) =>
        item.values?.includes('Payment signer adapter is not configured'),
      ),
    ).toBe(true);
  });

  it('submits exact calldata through the configured signer adapter', async () => {
    process.env.OPES_PAYMENT_SIGNER_URL =
      'https://signer.example.test/payments';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          transactionHash: `0x${'a'.repeat(64)}`,
        }),
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = recordingQuery(queries, workRow());
    const { service } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://signer.example.test/payments',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      queries.some((item) =>
        item.values?.some(
          (value) =>
            typeof value === 'string' && value.startsWith('0x7a154aae'),
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((item) => item.values?.includes(`0x${'a'.repeat(64)}`)),
    ).toBe(true);
  });

  it('stops when no execution event is ready', async () => {
    const query = jest.fn(() => queryResult([]));
    const { service, withWorker } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions()).resolves.toBe(0);
    expect(withWorker).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "status = 'PROCESSING' AND updated_at < now() - interval '5 minutes'",
      ),
    );
  });

  it('can reclaim stale processing payment executions after worker restart', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = recordingQuery(queries, workRow());
    const { service } = serviceWithWorker(query);

    await service.processDuePaymentExecutions(1);

    expect(
      queries.some((item) =>
        item.text.includes(
          "execution.status = 'PROCESSING' AND execution.updated_at < now() - interval '5 minutes'",
        ),
      ),
    ).toBe(true);
  });
});
