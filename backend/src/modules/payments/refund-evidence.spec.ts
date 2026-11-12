import { keccak256, stringToHex } from 'viem';
import { addressTopic } from '../../infrastructure/evm/lifecycle-chain-evidence';
import { verifyRefund } from './refund-evidence';

describe('refund cash evidence', () => {
  const originalRpc = process.env.OPES_RPC_ARC_TESTNET;
  const originalFinality = process.env.OPES_RECONCILIATION_FINALITY_BLOCKS;
  const hash = `0x${'a'.repeat(64)}`,
    blockHash = `0x${'b'.repeat(64)}`;
  const from = `0x${'1'.repeat(40)}`,
    to = `0x${'2'.repeat(40)}`;
  const input = {
    environment: 'arc-testnet',
    chainId: 5042002,
    transactionHash: hash,
    amount: '20',
    from,
    to,
  };
  beforeEach(() => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://rpc.invalid';
    process.env.OPES_RECONCILIATION_FINALITY_BLOCKS = '12';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalRpc === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
    else process.env.OPES_RPC_ARC_TESTNET = originalRpc;
    if (originalFinality === undefined)
      delete process.env.OPES_RECONCILIATION_FINALITY_BLOCKS;
    else process.env.OPES_RECONCILIATION_FINALITY_BLOCKS = originalFinality;
  });
  function provider(change: string) {
    const log = {
      address:
        change === 'token'
          ? from
          : '0x3600000000000000000000000000000000000000',
      topics: [
        keccak256(stringToHex('Transfer(address,address,uint256)')),
        addressTopic(change === 'sender' ? to : from),
        addressTopic(change === 'recipient' ? from : to),
      ],
      data: `0x${(change === 'amount' ? 21 : 20).toString(16).padStart(64, '0')}`,
      removed: change === 'removed',
    };
    const receipt = {
      status: change === 'revert' ? '0x0' : '0x1',
      transactionHash: hash,
      blockNumber: '0x64',
      blockHash,
      logs: [log],
    };
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      const { method } = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ) as { method: string };
      const result =
        method === 'eth_getTransactionReceipt'
          ? change === 'pending'
            ? null
            : receipt
          : method === 'eth_chainId'
            ? change === 'chain'
              ? '0x1'
              : `0x${input.chainId.toString(16)}`
            : method === 'eth_blockNumber'
              ? change === 'young'
                ? '0x65'
                : '0x80'
              : { hash: change === 'reorg' ? hash : blockHash };
      return Promise.resolve(Response.json({ result }));
    });
  }
  it('accepts only the finalized return of USDC to the original treasury', async () => {
    provider('valid');
    await expect(verifyRefund(input)).resolves.toMatchObject({
      amountAtomic: '20',
      from,
      to,
      blockHash,
    });
  });
  it.each([
    'token',
    'sender',
    'recipient',
    'amount',
    'removed',
    'revert',
    'pending',
    'chain',
    'young',
    'reorg',
  ])('refuses to book cash for %s evidence', async (change) => {
    provider(change);
    await expect(verifyRefund(input)).rejects.toThrow();
  });
});
