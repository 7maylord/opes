import { DatabaseService, TenantDatabase } from './database.service';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';

function serviceWithWorker(
  query: TenantDatabase['query'],
): LiquidityExecutionWorkerService {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return new LiquidityExecutionWorkerService({
    withWorker,
  } as unknown as DatabaseService);
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

function workRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    organization_id: 'organization-1',
    source_chain_id: 5042001,
    provider_payload: {
      signerRequest: {
        provider: 'circle',
        chainId: 5042001,
        from: '0x0000000000000000000000000000000000000001',
        to: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
        data: `0x8e0250ee${'0'.repeat(64)}`,
        value: '0',
      },
    },
    ...overrides,
  };
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
          aggregate_id: 'action-1',
        },
      ]);
    }
    if (
      text.includes('UPDATE opes.liquidity_actions') &&
      text.includes('RETURNING')
    ) {
      return queryResult(work === null ? [] : [work]);
    }
    return queryResult([]);
  });
}

describe('LiquidityExecutionWorkerService', () => {
  const originalUrl = process.env.OPES_PAYMENT_SIGNER_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.OPES_PAYMENT_SIGNER_URL;
    } else {
      process.env.OPES_PAYMENT_SIGNER_URL = originalUrl;
    }
    global.fetch = originalFetch;
  });

  it('fails visibly when signer is not configured', async () => {
    delete process.env.OPES_PAYMENT_SIGNER_URL;
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(recordingQuery(queries, workRow()));

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.values?.includes('Payment signer adapter is not configured'),
      ),
    ).toBe(true);
  });

  it('submits the precomputed CCTP burn request', async () => {
    process.env.OPES_PAYMENT_SIGNER_URL = 'https://signer.example.test/tx';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ transactionHash: `0x${'a'.repeat(64)}` }),
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(recordingQuery(queries, workRow()));

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://signer.example.test/tx',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      queries.some((item) => item.values?.includes(`0x${'a'.repeat(64)}`)),
    ).toBe(true);
  });

  it('stops when no liquidity event is ready', async () => {
    const service = serviceWithWorker(jest.fn(() => queryResult([])));

    await expect(service.processDueLiquidityActions()).resolves.toBe(0);
  });
});
