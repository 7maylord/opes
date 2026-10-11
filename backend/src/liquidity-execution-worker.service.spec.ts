import { keccak_256 } from '@noble/hashes/sha3.js';
import { DatabaseService, TenantDatabase } from './database.service';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';
import { CircleWalletService } from './circle-wallet.service';

function serviceWithWorker(
  query: TenantDatabase['query'],
  circle: Partial<CircleWalletService> = {},
): LiquidityExecutionWorkerService {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return new LiquidityExecutionWorkerService(
    {
      withWorker,
    } as unknown as DatabaseService,
    circle as CircleWalletService,
  );
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
    source_environment: 'arc-mainnet',
    source_chain_id: 5042001,
    source_asset_symbol: 'USDC',
    destination_environment: 'arbitrum-mainnet',
    destination_chain_id: 42161,
    destination_asset_symbol: 'USDC',
    amount_atomic: '25000000',
    provider_payload: {
      source: {
        environment: 'arc-mainnet',
        tier: 'mainnet',
        domain: 26,
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
    if (text.includes("SET status = 'MINTED'")) {
      return queryResult([
        {
          ...work,
          status: 'MINTED',
          provider_payload: {
            ...(work?.provider_payload as Record<string, unknown>),
            destinationMintTransactionHash: values?.[2],
          },
        },
      ]);
    }
    if (text.includes("SET status = 'SWAPPED'")) {
      return queryResult([
        {
          ...work,
          status: 'SWAPPED',
          provider_payload: {
            ...(work?.provider_payload as Record<string, unknown>),
            destinationSwapTransactionHash: values?.[2],
            destinationSwapOutputAmountAtomic: values?.[3],
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

function gatewayWorkRow(overrides: Record<string, unknown> = {}) {
  return workRow({
    action_type: 'GATEWAY_TRANSFER',
    status: 'PLANNED',
    source_environment: 'arc-mainnet',
    source_chain_id: 5042001,
    source_asset_symbol: 'USDC',
    destination_environment: 'base-mainnet',
    destination_chain_id: 8453,
    destination_asset_symbol: 'USDT',
    provider_payload: {
      destination: {
        environment: 'base-mainnet',
        walletAddress: '0x0000000000000000000000000000000000000002',
        walletId: 'base-wallet-1',
        gatewayMinter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
      },
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
        sourceContract: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
        destinationContract: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
        amountAtomic: '25000000',
        quoteExpiresAt: '2030-01-01T00:00:00.000Z',
        gatewayApiUrl: 'https://gateway.example.test/transfer',
        destinationSwap: {
          provider: 'configured',
          router: '0x0000000000000000000000000000000000000004',
          inputToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          outputToken: '0x0000000000000000000000000000000000000003',
          inputAmountAtomic: '25000000',
          minimumOutputAtomic: '24750000',
          inputAssetSymbol: 'USDC',
          outputAssetSymbol: 'USDT',
        },
      },
      destinationSwap: {
        provider: 'configured',
        router: '0x0000000000000000000000000000000000000004',
        inputToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        outputToken: '0x0000000000000000000000000000000000000003',
        inputAmountAtomic: '25000000',
        minimumOutputAtomic: '24750000',
        inputAssetSymbol: 'USDC',
        outputAssetSymbol: 'USDT',
      },
    },
    ...overrides,
  });
}

describe('LiquidityExecutionWorkerService', () => {
  const originalUrl = process.env.OPES_PAYMENT_SIGNER_URL;
  const originalAttestationUrl = process.env.OPES_CCTP_ATTESTATION_URL;
  const originalArcRpc = process.env.OPES_RPC_ARC_MAINNET;
  const originalBaseRpc = process.env.OPES_RPC_BASE_MAINNET;
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
    if (originalBaseRpc === undefined) {
      delete process.env.OPES_RPC_BASE_MAINNET;
    } else {
      process.env.OPES_RPC_BASE_MAINNET = originalBaseRpc;
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
          item.text.includes('INSERT INTO opes.outbox_events') &&
          item.values?.includes('liquidity.execute.cctp') &&
          item.values?.includes('15'),
      ),
    ).toBe(true);
  });

  it('persists the Gateway attestation before submitting its mint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          attestation: '0x1234',
          signature: '0xabcd',
        }),
    });
    const circle = {
      signTypedData: jest.fn().mockResolvedValue('0x5678'),
      createContractTransaction: jest
        .fn()
        .mockResolvedValue({ id: 'circle-mint-1', state: 'INITIATED' }),
    };
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(queries, gatewayWorkRow()),
      circle,
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(circle.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({ blockchain: 'ARC' }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example.test/transfer',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(circle.createContractTransaction).not.toHaveBeenCalled();
    expect(
      queries.some(
        (item) =>
          item.text.includes('SET status = $3') &&
          item.values?.includes('SUBMITTED') &&
          item.values?.includes('0x1234') &&
          item.values?.includes('0xabcd'),
      ),
    ).toBe(true);
  });

  it('submits a persisted Gateway attestation through the destination Circle wallet', async () => {
    const circle = {
      createContractTransaction: jest
        .fn()
        .mockResolvedValue({ id: 'circle-mint-1', state: 'INITIATED' }),
    };
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const base = gatewayWorkRow();
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        gatewayWorkRow({
          status: 'SUBMITTED',
          provider_payload: {
            ...(base.provider_payload as Record<string, unknown>),
            gatewayAttestation: '0x1234',
            gatewaySignature: '0xabcd',
          },
        }),
      ),
      circle,
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(circle.createContractTransaction).toHaveBeenCalledWith({
      walletAddress: '0x0000000000000000000000000000000000000002',
      blockchain: 'BASE',
      contractAddress: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
      abiFunctionSignature: 'gatewayMint(bytes,bytes)',
      abiParameters: ['0x1234', '0xabcd'],
      idempotencyKey: 'c00f2606-32a6-4428-b4dc-6078a17cda9e',
    });
    expect(queries.some((item) => item.values?.includes('circle-mint-1'))).toBe(
      true,
    );
  });

  it('settles a Circle-confirmed Gateway mint with a transaction hash', async () => {
    process.env.OPES_RPC_BASE_MAINNET = 'https://base-rpc.example.test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { status: '0x1', logs: [] } }),
    });
    const base = gatewayWorkRow();
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        gatewayWorkRow({
          status: 'SUBMITTED',
          destination_asset_symbol: 'USDC',
          provider_payload: {
            ...(base.provider_payload as Record<string, unknown>),
            destinationSwap: null,
            gatewayMintCircleTransactionId: 'circle-mint-1',
          },
        }),
      ),
      {
        getTransaction: jest.fn().mockResolvedValue({
          state: 'CONFIRMED',
          txHash: `0x${'c'.repeat(64)}`,
        }),
      },
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(
      queries.some(
        (item) =>
          item.text.includes("SET status = 'CONFIRMED'") &&
          item.values?.includes('action-1'),
      ),
    ).toBe(true);
  });

  it('submits the configured Base swap and posts liquidity ledger entries', async () => {
    process.env.OPES_PAYMENT_SIGNER_URL = 'https://signer.example.test/tx';
    process.env.OPES_RPC_BASE_MAINNET = 'https://base-rpc.example.test';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ result: { status: '0x1', logs: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            transactionHash: `0x${'d'.repeat(64)}`,
            outputAmountAtomic: '24900000',
          }),
      });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const service = serviceWithWorker(
      recordingQuery(
        queries,
        gatewayWorkRow({
          status: 'MINTED',
          provider_payload: {
            ...(gatewayWorkRow().provider_payload as Record<string, unknown>),
            destinationMintTransactionHash: `0x${'c'.repeat(64)}`,
          },
        }),
      ),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    const calls = (global.fetch as jest.MockedFunction<typeof fetch>).mock
      .calls;
    expect(calls[0]?.[0]).toBe('https://base-rpc.example.test');
    const requestInit = calls[1]?.[1];
    if (
      requestInit === undefined ||
      typeof requestInit !== 'object' ||
      typeof requestInit.body !== 'string'
    ) {
      throw new Error('expected swap request body');
    }
    const body = JSON.parse(requestInit.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: 'swap',
      action: 'swapExactInput',
      chainId: 8453,
      amountInAtomic: '25000000',
      minimumOutputAtomic: '24750000',
    });
    expect(
      queries.some((item) => item.text.includes("'LIQUIDITY_SWAP_SETTLED'")),
    ).toBe(true);
    expect(
      queries.some(
        (item) =>
          item.text.includes("SET status = 'CONFIRMED'") &&
          item.values?.includes('action-1'),
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
            source: { tier: 'mainnet', domain: 26 },
            sourceMessage: '0x123456',
            sourceMessageHash: `0x${'1'.repeat(64)}`,
            sourceBurnTransactionHash: `0x${'a'.repeat(64)}`,
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
          Promise.resolve({
            messages: [
              {
                status: 'complete',
                message: '0x123456',
                attestation: '0xabcdef01',
              },
            ],
          }),
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
            source: { tier: 'mainnet', domain: 26 },
            destination: {
              walletAddress: '0x0000000000000000000000000000000000000002',
              messageTransmitterV2:
                '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
            },
            sourceMessage: '0x123456',
            sourceMessageHash: `0x${'1'.repeat(64)}`,
            sourceBurnTransactionHash: `0x${'a'.repeat(64)}`,
          },
        }),
      ),
    );

    await expect(service.processDueLiquidityActions(1)).resolves.toBe(1);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `https://iris.example.test/v2/messages/26?transactionHash=0x${'a'.repeat(64)}`,
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
    const query = jest.fn(() => queryResult([]));
    const service = serviceWithWorker(query);

    await expect(service.processDueLiquidityActions()).resolves.toBe(0);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "status = 'PROCESSING' AND updated_at < now() - interval '5 minutes'",
      ),
    );
  });
});
