import {
  hex,
  recordMovement,
  rpc,
  suggestedLogRangeEnd,
  topicAddress,
  transferLogs,
} from './treasury-reconciliation.service';

describe('treasury reconciliation parsing', () => {
  it('normalizes block numbers and indexed EVM addresses', () => {
    expect(hex(255)).toBe('0xff');
    expect(
      topicAddress(
        `0x${'0'.repeat(24)}ABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD`,
      ),
    ).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });
  it('records an omitted movement as one tenant-scoped exception', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'movement-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await recordMovement(
      { query },
      {
        organizationId: 'org-1',
        environment: 'arc-testnet',
        chainId: 5042002,
        fromAddress: '0x1111111111111111111111111111111111111111',
        toAddress: '0x2222222222222222222222222222222222222222',
        log: {
          address: '0x3333333333333333333333333333333333333333',
          blockNumber: '0xa',
          blockHash: `0x${'1'.repeat(64)}`,
          transactionHash: `0x${'2'.repeat(64)}`,
          logIndex: '0x0',
          topics: [],
          data: '0xf4240',
        },
      },
    );
    expect(query).toHaveBeenCalledTimes(3);
    const calls = query.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toContain(
      'ON CONFLICT(organization_id,chain_id,transaction_hash,log_index)',
    );
    expect(calls[2][0]).toContain('UNMATCHED_ONCHAIN_MOVEMENT');
    expect(calls[2][0]).toContain('$4::text');
  });
  it('uses a provider-suggested log range without skipping blocks', () => {
    expect(
      suggestedLogRangeEnd(
        new Error('request too large; range should work: [0x64, 0x6d]'),
        100,
      ),
    ).toBe(109);
    expect(
      suggestedLogRangeEnd(new Error('range should work: [0x65, 0x6e]'), 100),
    ).toBeNull();
  });
});

describe('treasury RPC failures', () => {
  const originalUrl = process.env.OPES_RPC_ARC_TESTNET;
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
    else process.env.OPES_RPC_ARC_TESTNET = originalUrl;
  });
  it('catches up a long outage in contiguous pages and propagates failures before balances are confirmed', async () => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid';
    const ranges: number[][] = [];
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((_url, options) => {
        const { params } = JSON.parse(options!.body as string) as {
          params: [{ fromBlock: string; toBlock: string }];
        };
        const from = Number(BigInt(params[0].fromBlock));
        const to = Number(BigInt(params[0].toBlock));
        ranges.push([from, to]);
        return Promise.resolve(
          Response.json(
            to - from >= 4
              ? { error: { message: 'requested range too large' } }
              : { result: [] },
          ),
        );
      });
    await transferLogs('arc-testnet', '0x1', 100, 10_105);
    const accepted = ranges.filter(([from, to]) => to - from < 4);
    expect(accepted[0][0]).toBe(100);
    expect(accepted.at(-1)![1]).toBe(10_105);
    accepted
      .slice(1)
      .forEach(([from], i) => expect(from).toBe(accepted[i][1] + 1));
    expect(ranges.every(([from, to]) => to - from < 9_999)).toBe(true);
    fetchMock.mockResolvedValue(
      Response.json({ error: { message: 'unauthorized' } }),
    );
    await expect(transferLogs('arc-testnet', '0x1', 100, 101)).rejects.toThrow(
      'unauthorized',
    );
  });
  it('identifies an unauthorized provider even with a plain-text body', async () => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid/secret';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(rpc('arc-testnet', 'eth_blockNumber', [])).rejects.toThrow(
      'OPES_RPC_ARC_TESTNET eth_blockNumber: HTTP 401',
    );
  });
  it('preserves provider range hints on HTTP errors so reconciliation can resume', async () => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json(
          { error: { message: 'range should work: [0x64, 0x6d]' } },
          { status: 400 },
        ),
      );
    const error = await rpc('arc-testnet', 'eth_getLogs', []).catch(
      (error: unknown) => error,
    );
    expect(suggestedLogRangeEnd(error, 100)).toBe(109);
  });
  it('rejects missing results instead of treating them as confirmed balances', async () => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1 }));
    await expect(rpc('arc-testnet', 'eth_call', [])).rejects.toThrow(
      'missing RPC result',
    );
  });
});
