import { keccak_256 } from '@noble/hashes/sha3.js';
import { CircleWalletService } from '../../infrastructure/circle/circle-wallet.service';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import {
  buildErc20TransferCalldata,
  buildExecuteDirectPaymentCalldata,
} from '../../infrastructure/evm/evm-calldata';
import { FactoryManifestService } from '../../infrastructure/contracts/factory-manifest.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';

const tokenAddress = '0x3600000000000000000000000000000000000000';
const txHash = `0x${'a'.repeat(64)}`;

function serviceWithWorker(
  query: TenantDatabase['query'],
  circle: Partial<CircleWalletService> = {},
) {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return {
    service: new PaymentExecutionWorkerService(
      { withWorker } as unknown as DatabaseService,
      { isConfigured: () => true, ...circle } as CircleWalletService,
      {
        getArcTestnetFactory: () => ({ tokenAddress }),
      } as FactoryManifestService,
    ),
    withWorker,
  };
}

function workRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    organization_id: '11111111-1111-1111-1111-111111111111',
    decision_hash: `0x${'d'.repeat(64)}`,
    idempotency_key: 'e'.repeat(64),
    context_hash: 'c'.repeat(64),
    amount_atomic: '12340001',
    destination_address: '0x0000000000000000000000000000000000000002',
    route_chain_id: 5042002,
    route_environment: 'arc-testnet',
    route_asset_symbol: 'USDC',
    vault_address: '0x0000000000000000000000000000000000000003',
    expires_at: new Date('2030-01-01T00:00:00.000Z'),
    wallet_id: 'circle-wallet-1',
    wallet_address: '0x0000000000000000000000000000000000000004',
    execution_mode: 'DIRECT_VAULT',
    token_address: null,
    liquidity_action_id: null,
    max_source_debit_atomic: null,
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
  attempt?: {
    id: string;
    status?: string;
    provider_transaction_id: string | null;
    call_data: string;
  },
): jest.Mock {
  return jest.fn((text: string, values?: readonly unknown[]) => {
    queries.push({ text, values });
    if (text.includes('RETURNING id, organization_id, aggregate_id')) {
      return queryResult([
        {
          id: 'event-1',
          organization_id: '11111111-1111-1111-1111-111111111111',
          aggregate_id: '55555555-5555-5555-5555-555555555555',
        },
      ]);
    }
    if (
      text.includes('UPDATE opes.payment_executions AS execution') &&
      text.includes('wallet.resource_id')
    ) {
      return queryResult(work === null ? [] : [work]);
    }
    if (
      text.includes('FROM opes.payment_execution_attempts') &&
      text.includes('ORDER BY')
    ) {
      return queryResult(attempt ? [{ status: 'SUBMITTED', ...attempt }] : []);
    }
    if (text.includes('AS vendor_daily_committed_atomic'))
      return queryResult([
        {
          derived_action: 'PAY',
          decision_expires_at: new Date('2030-01-01T00:00:00.000Z'),
          policy_status: work?.preflight_policy_status ?? 'ACTIVE',
          organization_status: 'ACTIVE',
          agent_status: 'ACTIVE',
          vendor_status: 'VERIFIED',
          vendor_version: 1,
          bound_vendor_version: 1,
          address_status: 'VERIFIED_ACTIVE',
          address_version: work?.preflight_address_version ?? 1,
          bound_address_version: 1,
          payout_address: work?.destination_address,
          source_status: 'ACCEPTED',
          obligation_status: 'ACCEPTED',
          has_evidence_match: true,
          reservation_status: 'CONSUMED',
          has_active_approval: false,
          single_payment_limit_atomic: '1000000000',
          vendor_daily_limit_atomic: '1000000000',
          organization_daily_limit_atomic: '1000000000',
          monthly_budget_atomic: '1000000000',
          operating_buffer_atomic: '1000',
          vendor_daily_committed_atomic: work?.amount_atomic,
          organization_daily_committed_atomic: work?.amount_atomic,
          monthly_committed_atomic: work?.amount_atomic,
          duplicate_execution: false,
          max_source_debit_atomic: work?.max_source_debit_atomic ?? null,
        },
      ]);
    if (text.includes('SELECT id FROM opes.payment_executions'))
      return queryResult([{ id: 'execution-1' }]);
    if (text.includes('INSERT INTO opes.payment_execution_attempts'))
      return queryResult([{ id: 'attempt-1' }]);
    if (
      text.includes('FROM opes.payment_executions AS execution') &&
      text.includes('JOIN opes.payment_decisions')
    ) {
      return queryResult([
        {
          execution_id: '55555555-5555-5555-5555-555555555555',
          decision_id: 'decision-1',
          source_version_id: 'version-1',
          vendor_id: 'vendor-1',
          route_asset_symbol: 'USDC',
          route_environment: work?.route_environment ?? 'arc-testnet',
          amount_atomic: '12340001',
          status: 'CONFIRMED',
          transaction_hash: txHash,
        },
      ]);
    }
    return queryResult([]);
  });
}

function eventTopic(signature: string): string {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString('hex')}`;
}
function mockPreflightRpc(balance = '0x3b9aca00', paused = '0x0') {
  process.env.OPES_RPC_ARC_TESTNET = 'https://arc-rpc.example.test';
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: '0x64' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: balance }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: '0x1' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: paused }),
    });
}
function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}
function word(value: bigint | string): string {
  const hex =
    typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.padStart(64, '0');
}

describe('PaymentExecutionWorkerService', () => {
  const originalFetch = global.fetch;
  const originalRpc = process.env.OPES_RPC_ARC_TESTNET;
  const originalBaseRpc = process.env.OPES_RPC_BASE_SEPOLIA;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalRpc === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
    else process.env.OPES_RPC_ARC_TESTNET = originalRpc;
    if (originalBaseRpc === undefined) delete process.env.OPES_RPC_BASE_SEPOLIA;
    else process.env.OPES_RPC_BASE_SEPOLIA = originalBaseRpc;
  });

  it('fails visibly when the tenant operator wallet is missing', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(recordingQuery(queries, null));
    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.values?.includes(
          'Active Circle operator wallet binding is missing',
        ),
      ),
    ).toBe(true);
  });

  it('submits exact calldata through the bound Circle wallet and requeues reconciliation', async () => {
    mockPreflightRpc();
    const row = workRow();
    const createDirectPaymentTransaction = jest
      .fn()
      .mockResolvedValue({ id: 'circle-tx-1', state: 'INITIATED' });
    const getTransaction = jest.fn().mockResolvedValue({
      id: 'circle-tx-1',
      state: 'INITIATED',
      blockchain: 'ARC-TESTNET',
      walletId: row.wallet_id,
      sourceAddress: row.wallet_address,
      contractAddress: row.vault_address,
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(recordingQuery(queries, row), {
      createDirectPaymentTransaction,
      getTransaction,
    });

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: row.decision_hash,
      obligationKey: row.idempotency_key,
      contextHash: row.context_hash,
      idempotencyKey: row.idempotency_key,
      vendor: row.destination_address,
      amount: row.amount_atomic,
      expiresAt: row.expires_at.toISOString(),
    });
    expect(createDirectPaymentTransaction).toHaveBeenCalledWith({
      walletId: 'circle-wallet-1',
      vaultAddress: row.vault_address,
      callData,
      executionId: row.id,
    });
    expect(queries.some((item) => item.values?.includes('circle-tx-1'))).toBe(
      true,
    );
    expect(
      queries.some((item) =>
        item.text.includes("available_at = now() + interval '5 seconds'"),
      ),
    ).toBe(true);
  });

  it('fails a provider-rejected request instead of retrying forever', async () => {
    mockPreflightRpc();
    const error = Object.assign(new Error('API parameter invalid'), {
      status: 400,
      code: 400,
      error: {
        response: {
          data: { code: 155201, message: 'Gas parameters are invalid' },
        },
      },
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(recordingQuery(queries, workRow()), {
      createDirectPaymentTransaction: jest.fn().mockRejectedValue(error),
    });

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some(
        (item) =>
          item.text.includes("SET status = 'FAILED'") &&
          item.values?.includes(
            'Gas parameters are invalid (Circle code 155201)',
          ),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (item) =>
          item.text.includes('opes.workspace_notifications') &&
          item.values?.includes('invoices'),
      ),
    ).toBe(true);
    expect(
      queries.some((item) =>
        item.text.includes("available_at = now() + interval '5 seconds'"),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'changed policy',
      { preflight_policy_status: 'SUPERSEDED' },
      '0x3b9aca00',
      '0x0',
    ],
    ['changed address', { preflight_address_version: 2 }, '0x3b9aca00', '0x0'],
    ['changed balance', {}, '0x1', '0x0'],
    ['paused vault', {}, '0x3b9aca00', '0x1'],
  ])('blocks signing after %s', async (_name, overrides, balance, paused) => {
    mockPreflightRpc(balance, paused);
    const createDirectPaymentTransaction = jest.fn();
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(
      recordingQuery(queries, workRow(overrides)),
      { createDirectPaymentTransaction },
    );

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(createDirectPaymentTransaction).not.toHaveBeenCalled();
    expect(
      queries.some(
        (item) =>
          item.text.includes('payment_execution_preflights') &&
          item.values?.includes('BLOCK'),
      ),
    ).toBe(true);
  });

  it('marks an ambiguous source submission unknown and never submits it again', async () => {
    mockPreflightRpc();
    const createDirectPaymentTransaction = jest
      .fn()
      .mockRejectedValue(new TypeError('request timed out'));
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(recordingQuery(queries, workRow()), {
      createDirectPaymentTransaction,
    });
    await service.processDuePaymentExecutions(1);
    expect(
      queries.some(
        (item) =>
          item.text.includes("status='UNKNOWN'") &&
          item.values?.includes('request timed out'),
      ),
    ).toBe(true);
    expect(
      queries.some((item) =>
        item.text.includes("available_at = now() + interval '5 seconds'"),
      ),
    ).toBe(false);

    const secondQueries: Array<{ text: string; values?: readonly unknown[] }> =
      [];
    const replay = workRow();
    const { service: second } = serviceWithWorker(
      recordingQuery(secondQueries, replay, {
        id: 'attempt-1',
        status: 'UNKNOWN',
        provider_transaction_id: null,
        call_data: buildExecuteDirectPaymentCalldata({
          decisionHash: replay.decision_hash,
          obligationKey: replay.idempotency_key,
          contextHash: replay.context_hash,
          idempotencyKey: replay.idempotency_key,
          vendor: replay.destination_address,
          amount: replay.amount_atomic,
          expiresAt: replay.expires_at.toISOString(),
        }),
      }),
      { createDirectPaymentTransaction },
    );
    await second.processDuePaymentExecutions(1);
    expect(createDirectPaymentTransaction).toHaveBeenCalledTimes(1);
  });

  it('retries when Circle has not indexed a submitted transaction yet', async () => {
    const error = Object.assign(new Error('payment execution not found'), {
      status: 404,
    });
    const row = workRow();
    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: row.decision_hash,
      obligationKey: row.idempotency_key,
      contextHash: row.context_hash,
      idempotencyKey: row.idempotency_key,
      vendor: row.destination_address,
      amount: row.amount_atomic,
      expiresAt: row.expires_at.toISOString(),
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(
      recordingQuery(queries, row, {
        id: 'attempt-1',
        provider_transaction_id: 'circle-tx-1',
        call_data: callData,
      }),
      { getTransaction: jest.fn().mockRejectedValue(error) },
    );

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.text.includes("available_at = now() + interval '5 seconds'"),
      ),
    ).toBe(true);
    expect(
      queries.some((item) => item.text.includes("SET status = 'FAILED'")),
    ).toBe(false);
  });

  it('keeps reconciling submitted payments after authorization expiry', async () => {
    const error = Object.assign(new Error('payment execution not found'), {
      status: 404,
    });
    const row = workRow({ expires_at: new Date('2020-01-01T00:00:00Z') });
    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: row.decision_hash,
      obligationKey: row.idempotency_key,
      contextHash: row.context_hash,
      idempotencyKey: row.idempotency_key,
      vendor: row.destination_address,
      amount: row.amount_atomic,
      expiresAt: row.expires_at.toISOString(),
    });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(
      recordingQuery(queries, row, {
        id: 'attempt-1',
        provider_transaction_id: 'circle-tx-1',
        call_data: callData,
      }),
      { getTransaction: jest.fn().mockRejectedValue(error) },
    );

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.text.includes("available_at = now() + interval '5 seconds'"),
      ),
    ).toBe(true);
    expect(
      queries.some((item) => item.text.includes("SET status = 'FAILED'")),
    ).toBe(false);
  });

  it('confirms only matching Arc receipt events and projects the ledger', async () => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://arc-rpc.example.test';
    const row = workRow();
    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: row.decision_hash,
      obligationKey: row.idempotency_key,
      contextHash: row.context_hash,
      idempotencyKey: row.idempotency_key,
      vendor: row.destination_address,
      amount: row.amount_atomic,
      expiresAt: row.expires_at.toISOString(),
    });
    const attempt = {
      id: 'attempt-1',
      provider_transaction_id: 'circle-tx-1',
      call_data: callData,
    };
    const getTransaction = jest.fn().mockResolvedValue({
      id: 'circle-tx-1',
      state: 'COMPLETE',
      txHash,
      blockchain: 'ARC-TESTNET',
      walletId: row.wallet_id,
      sourceAddress: row.wallet_address,
      contractAddress: row.vault_address,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              from: row.wallet_address,
              to: row.vault_address,
              input: callData,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              status: '0x1',
              transactionHash: txHash,
              logs: [
                {
                  address: row.vault_address,
                  topics: [
                    eventTopic(
                      'PaymentExecuted(bytes32,bytes32,address,uint256,address)',
                    ),
                    row.decision_hash,
                    `0x${row.idempotency_key}`,
                    addressTopic(row.destination_address),
                  ],
                  data: `0x${word(BigInt(row.amount_atomic))}${word(row.wallet_address)}`,
                },
                {
                  address: tokenAddress,
                  topics: [
                    eventTopic('Transfer(address,address,uint256)'),
                    addressTopic(row.vault_address),
                    addressTopic(row.destination_address),
                  ],
                  data: `0x${word(BigInt(row.amount_atomic))}`,
                },
              ],
            },
          }),
      });
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(
      recordingQuery(queries, row, attempt),
      { getTransaction },
    );

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) => item.text.includes("SET status = 'CONFIRMED'")),
    ).toBe(true);
    expect(
      queries.some((item) =>
        item.text.includes("set_config('opes.organization_id'"),
      ),
    ).toBe(true);
    expect(
      queries.some((item) =>
        item.text.includes('INSERT INTO opes.ledger_entries'),
      ),
    ).toBe(true);
    expect(
      queries.some((item) => item.text.includes("SET status = 'PAID'")),
    ).toBe(true);
    expect(
      queries.some((item) => item.text.includes("SET status = 'PROCESSED'")),
    ).toBe(true);
  });

  it('rejects a Circle transaction from another wallet before querying Arc', async () => {
    const row = workRow();
    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: row.decision_hash,
      obligationKey: row.idempotency_key,
      contextHash: row.context_hash,
      idempotencyKey: row.idempotency_key,
      vendor: row.destination_address,
      amount: row.amount_atomic,
      expiresAt: row.expires_at.toISOString(),
    });
    const attempt = {
      id: 'attempt-1',
      provider_transaction_id: 'circle-tx-1',
      call_data: callData,
    };
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const { service } = serviceWithWorker(
      recordingQuery(queries, row, attempt),
      {
        getTransaction: jest.fn().mockResolvedValue({
          id: 'circle-tx-1',
          state: 'COMPLETE',
          txHash,
          blockchain: 'ARC-TESTNET',
          walletId: 'wrong-wallet',
          sourceAddress: row.wallet_address,
          contractAddress: row.vault_address,
        }),
      },
    );

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(
      queries.some((item) =>
        item.values?.includes(
          'Circle transaction does not match the authorized payment',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    { transferAmount: '12340001', confirmed: true },
    { transferAmount: '12340002', confirmed: false },
  ])(
    'settles Base USDC only when the transfer amount is exact: $confirmed',
    async ({ transferAmount, confirmed }) => {
      process.env.OPES_RPC_BASE_SEPOLIA = 'https://base-rpc.example.test';
      const baseUsdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const row = workRow({
        route_chain_id: 84532,
        route_environment: 'base-sepolia',
        vault_address: null,
        execution_mode: 'CROSSCHAIN_WALLET',
        token_address: baseUsdc,
        liquidity_action_id: 'liquidity-1',
      });
      const callData = buildErc20TransferCalldata(
        row.destination_address,
        row.amount_atomic,
      );
      const attempt = {
        id: 'attempt-1',
        provider_transaction_id: 'circle-tx-1',
        call_data: callData,
      };
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              result: {
                from: row.wallet_address,
                to: baseUsdc,
                input: callData,
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              result: {
                status: '0x1',
                transactionHash: txHash,
                logs: [
                  {
                    address: baseUsdc,
                    topics: [
                      eventTopic('Transfer(address,address,uint256)'),
                      addressTopic(row.wallet_address),
                      addressTopic(row.destination_address),
                    ],
                    data: `0x${word(BigInt(transferAmount))}`,
                  },
                ],
              },
            }),
        });
      const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
      const { service } = serviceWithWorker(
        recordingQuery(queries, row, attempt),
        {
          getTransaction: jest.fn().mockResolvedValue({
            id: 'circle-tx-1',
            state: 'CONFIRMED',
            txHash,
            blockchain: 'BASE-SEPOLIA',
            walletId: row.wallet_id,
            sourceAddress: row.wallet_address,
            contractAddress: baseUsdc,
          }),
        },
      );

      await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
      expect(
        queries.some((item) => item.text.includes("SET status = 'CONFIRMED'")),
      ).toBe(confirmed);
      expect(
        queries.some((item) =>
          item.text.includes('INSERT INTO opes.ledger_entries'),
        ),
      ).toBe(confirmed);
      expect(
        queries.some(
          (item) =>
            item.text.includes('INSERT INTO opes.ledger_entries') &&
            item.values?.includes('ASSET:BASE_SEPOLIA:USDC'),
        ),
      ).toBe(confirmed);
      expect(
        queries.some((item) => item.text.includes("SET status = 'PAID'")),
      ).toBe(confirmed);
    },
  );

  it('stops when no execution event is ready', async () => {
    const query = jest.fn(() => queryResult([]));
    const { service, withWorker } = serviceWithWorker(query);
    await expect(service.processDuePaymentExecutions()).resolves.toBe(0);
    expect(withWorker).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("updated_at < now() - interval '5 minutes'"),
    );
  });
});
