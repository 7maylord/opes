import {
  hex,
  recordMovement,
  topicAddress,
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
  });
});
