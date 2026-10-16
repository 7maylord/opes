import { DatabaseService, TenantDatabase } from './database.service';
import { RecurringExecutionService } from './recurring-execution.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  membershipId: '33333333-3333-4333-8333-333333333333',
  agentId: '44444444-4444-4444-8444-444444444444',
  role: 'OWNER',
  requestId: 'request-1',
};
const owner = '0x1111111111111111111111111111111111111111';
const vault = '0x2222222222222222222222222222222222222222';
const transactionHash = `0x${'3'.repeat(64)}`;

describe('owner vault lifecycle confirmation', () => {
  const originalRpc = process.env.OPES_RPC_ARC_TESTNET;

  beforeAll(() => {
    process.env.OPES_RPC_ARC_TESTNET = 'https://arc.example.test';
  });
  afterAll(() => {
    if (originalRpc === undefined) delete process.env.OPES_RPC_ARC_TESTNET;
    else process.env.OPES_RPC_ARC_TESTNET = originalRpc;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['RESUME_VAULT', 'ACTIVE'],
    ['PAUSE_VAULT', 'PAUSED'],
  ])(
    'marks the workspace %s after exact onchain confirmation',
    async (actionType, expectedStatus) => {
      const query = jest.fn((sql: string) => {
        if (sql.includes('SELECT action.*')) {
          return Promise.resolve({
            rows: [
              {
                id: 'action-1',
                organization_id: context.organizationId,
                action_type: actionType,
                target_id: 'target-1',
                actor: 'OWNER',
                contract_address: vault,
                call_data: '0x1234',
                idempotency_key: 'key-1',
                payload: {},
                status: 'PREPARED',
                provider_transaction_id: null,
                owner_address: owner,
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      });
      const database = {
        withTenant: jest.fn(
          (_: TenantContext, work: (db: TenantDatabase) => unknown) =>
            work({ query }),
        ),
      } as unknown as DatabaseService;
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { from: owner, to: vault, input: '0x1234' },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { status: '0x1' } })),
        );

      await new RecurringExecutionService(
        database,
        {} as never,
        {} as never,
      ).confirmOwnerAction(context, 'action-1', transactionHash);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE opes.organizations'),
        [context.organizationId, expectedStatus],
      );
    },
  );
});
