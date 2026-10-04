import { keccak_256 } from '@noble/hashes/sha3.js';
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
    action_type: 'CCTP_TRANSFER',
    status: 'PLANNED',
    source_chain_id: 5042001,
    destination_chain_id: 42161,
    provider_payload: {
      source: {
        environment: 'arc-mainnet',
        tier: 'mainnet',
        messageTransmitterV2: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      },
      destination: {
        walletAddress: '0x0000000000000000000000000000000000000002',
        messageTransmitterV2: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      },
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
          event_type:
            work?.action_type === 'GATEWAY_TRANSFER'
              ? 'liquidity.execute.gateway'
              : 'liquidity.execute.cctp',
        },
      ]);
    }
    if (
      text.includes('FROM opes.liquidity_actions') &&
      text.includes('LIMIT 1')
    ) {
      return queryResult(work === null ? [] : [work]);
    }
    if (text.includes("SET status = 'ATTESTED'")) {
      return queryResult([
        {
          ...workRow({ status: 'ATTESTED' }),
          action_type: 'CCTP_TRANSFER',
          provider_payload: {
            ...(workRow({}).provider_payload as Record<string, unknown>),
            sourceMessage: '0x123456',
            sourceMessageHash: `0x${'1'.repeat(64)}`,
            attestation: '0xabcdef01',
          },
        },
      ]);
    }
    if (
      text.includes("'sourceMessage', $3::text") &&
      text.includes("'sourceMessageHash', $4::text")
    ) {
      return queryResult([
        {
          ...workRow({ status: 'SUBMITTED' }),
          action_type: 'CCTP_TRANSFER',
          provider_payload: {
            ...(work?.provider_payload as Record<string, unknown>),
            sourceMessage: values?.[2],
            sourceMessageHash: values?.[3],
          },
        },
      ]);
    }
    return queryResult([]);
  });
}

function hashHexBytes(value: string): string {
  return `0x${Buffer.from(
    keccak_256(Buffer.from(value.slice(2), 'hex')),
  ).toString('hex')}`;
}

function hashText(value: string): string {
  return `0x${Buffer.from(keccak_256(Buffer.from(value))).toString('hex')}`;
}

function abiBytes(value: string): string {
  const data = value.slice(2);
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  const length = (data.length / 2).toString(16);
  return `0x${pad64('20')}${pad64(length)}${padded}`;
}

function pad64(value: string): string {
  return value.padStart(64, '0');
}

function gatewayWorkRow() {
  return workRow({
    action_type: 'GATEWAY_TRANSFER',
    status: 'PLANNED',
    source_chain_id: 5042001,
    destination_chain_id: 8453,
    provider_payload: {
      gatewayRequest: {
        provider: 'circle-gateway',
        action: 'transferUnifiedUsdc',
        sourceChainId: 5042001,
        destinationChainId: 8453,
        sourceDomain: 26,
        destinationDomain: 6,
        sourceDepositor: '0x0000000000000000000000000000000000000001',
        destinationRecipient: '0x0000000000000000000000000000000000000002',
        sourceToken: '0x3600000000000000000000000000000000000000',
        destinationToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amountAtomic: '25000000',
        quoteExpiresAt: '2030-01-01T00:00:00.000Z',
        gatewayApiUrl: 'https://gateway.example.test/transfer',
        destinationSwap: {
          provider: 'configured',
          router: '0x0000000000000000000000000000000000000004',
          inputToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          outputToken: '0x0000000000000000000000000000000000000003',
          inputAssetSymbol: 'USDC',
          outputAssetSymbol: 'USDT',
        },
      },
    },
  });
}

describe('LiquidityExecutionWorkerService', () => {
  const originalUrl = process.env.OPES_PAYMENT_SIGNER_URL;
  const originalAttestationUrl = process.env.OPES_CCTP_ATTESTATION_URL;
  const originalArcRpc = process.env.OPES_RPC_ARC_MAINNET;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.OPES_PAYMENT_SIGNER_URL;
    } else {
      process.env.OPES_PAYMENT_SIGNER_URL = originalUrl;
    }
    if (originalAttestationUrl === undefined) {
      delete process.env.OPES_CCTP_ATTESTATION_URL;
    } else {
      process.env.OPES_CCTP_ATTESTATION_URL = originalAttestationUrl;
    }
    if (originalArcRpc === undefined) {
      delete process.env.OPES_RPC_ARC_MAINNET;
    } else {
      process.env.OPES_RPC_ARC_MAINNET = originalArcRpc;
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
    expect(
      queries.some(
        (item) =>
          item.text.includes('liquidity.execute.cctp') &&
          item.text.includes("interval '15 seconds'"),
      ),
    ).toBe(true);
  });

  it('submits a Gateway transfer request through the signer adapter', async () => {
    process.env.OPES_PAYMENT_SIGNER_URL = 'https://signer.example.test/tx';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          transferId: 'gateway-transfer-1',
          transactionHash: `0x${'c'.repeat(64)}`,
        }),
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(queries, gatewayWorkRow()),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    const calls = (global.fetch as jest.MockedFunction<typeof fetch>).mock
      .calls;
    const requestInit = calls[0]?.[1];
    if (
      requestInit === undefined ||
      typeof requestInit !== 'object' ||
      typeof requestInit.body !== 'string'
    ) {
      throw new Error('expected signer request body');
    }
    const body = JSON.parse(requestInit.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: 'circle-gateway',
      action: 'transferUnifiedUsdc',
      sourceChainId: 5042001,
      destinationChainId: 8453,
      amountAtomic: '25000000',
    });
    expect(body.destinationSwap).toMatchObject({ outputAssetSymbol: 'USDT' });
    expect(
      queries.some(
        (item) =>
          item.text.includes('SET status = $3') &&
          item.values?.includes('MINTED') &&
          item.values?.includes('gateway-transfer-1'),
      ),
    ).toBe(true);
  });

  it('extracts the CCTP source message from the burn receipt before attestation', async () => {
    process.env.OPES_RPC_ARC_MAINNET = 'https://arc-rpc.example.test';
    process.env.OPES_CCTP_ATTESTATION_URL = 'https://iris.example.test';
    const sourceMessage = '0x123456';
    const sourceMessageHash = hashHexBytes(sourceMessage);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              status: '0x1',
              logs: [
                {
                  topics: [hashText('MessageSent(bytes)')],
                  data: abiBytes(sourceMessage),
                },
              ],
            },
          }),
      })
      .mockResolvedValueOnce({ status: 404, ok: false });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        workRow({
          status: 'SUBMITTED',
          provider_payload: {
            ...(workRow().provider_payload as Record<string, unknown>),
            sourceBurnTransactionHash: `0x${'a'.repeat(64)}`,
          },
        }),
      ),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://arc-rpc.example.test',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      queries.some(
        (item) =>
          item.values?.includes(sourceMessage) &&
          item.values?.includes(sourceMessageHash),
      ),
    ).toBe(true);
  });

  it('reschedules when attestation is still pending', async () => {
    process.env.OPES_CCTP_ATTESTATION_URL = 'https://iris.example.test';
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        workRow({
          status: 'SUBMITTED',
          provider_payload: {
            source: { tier: 'mainnet' },
            sourceMessage: '0x123456',
            sourceMessageHash: `0x${'1'.repeat(64)}`,
          },
        }),
      ),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(
      queries.some(
        (item) =>
          item.text.includes("SET status = 'PENDING'") &&
          item.values?.includes('60'),
      ),
    ).toBe(true);
  });

  it('records attestation and submits destination receiveMessage', async () => {
    process.env.OPES_PAYMENT_SIGNER_URL = 'https://signer.example.test/tx';
    process.env.OPES_CCTP_ATTESTATION_URL = 'https://iris.example.test';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ status: 'complete', attestation: '0xabcdef01' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ transactionHash: `0x${'b'.repeat(64)}` }),
      });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        workRow({
          status: 'SUBMITTED',
          provider_payload: {
            source: { tier: 'mainnet' },
            destination: {
              walletAddress: '0x0000000000000000000000000000000000000002',
              messageTransmitterV2:
                '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
            },
            sourceMessage: '0x123456',
            sourceMessageHash: `0x${'1'.repeat(64)}`,
          },
        }),
      ),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `https://iris.example.test/v1/attestations/0x${'1'.repeat(64)}`,
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://signer.example.test/tx',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      queries.some((item) => item.values?.includes(`0x${'b'.repeat(64)}`)),
    ).toBe(true);
  });

  it('stops when no liquidity event is ready', async () => {
    const service = serviceWithWorker(jest.fn(() => queryResult([])));

    await expect(service.processDueLiquidityActions()).resolves.toBe(0);
  });
});
