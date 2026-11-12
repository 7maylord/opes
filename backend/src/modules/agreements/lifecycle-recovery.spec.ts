import {
  RecurringExecutionService,
  ActionRow,
} from './recurring-execution.service';
import { EscrowExecutionService } from './escrow-execution.service';

describe.each(['recurring', 'escrow'] as const)(
  '%s settlement recovery',
  (kind) => {
    function setup(ownsClaim = true) {
      const query = jest.fn((sql: string) =>
        Promise.resolve({
          rows:
            sql.includes('SELECT id FROM opes.lifecycle_chain_actions') &&
            ownsClaim
              ? [{ id: 'action' }]
              : [],
        }),
      );
      const database = {
        withWorker: (work: (db: unknown) => unknown) => work({ query }),
      };
      const circle = {
        getTransaction: jest
          .fn()
          .mockRejectedValue(new TypeError('provider timeout')),
      };
      const service =
        kind === 'recurring'
          ? new RecurringExecutionService(
              database as never,
              circle as never,
              {} as never,
            )
          : new EscrowExecutionService(
              database as never,
              circle as never,
              {} as never,
            );
      const internal = service as unknown as {
        execute(action: ActionRow): Promise<void>;
        recurringEvidence(): Promise<unknown>;
        escrowEvidence(): Promise<unknown>;
      };
      jest
        .spyOn(
          internal,
          kind === 'recurring' ? 'recurringEvidence' : 'escrowEvidence',
        )
        .mockResolvedValue({});
      const action = {
        id: 'action',
        action_type: 'FUND_ESCROW',
        claim_token: 'claim',
        organization_id: 'org',
        target_id: 'target',
        provider_transaction_id: 'provider',
      } as ActionRow;
      return { query, circle, internal, action };
    }
    it('retains submitted state when the provider temporarily cannot be reached', async () => {
      const { query, internal, action } = setup();
      await internal.execute(action);
      expect(
        query.mock.calls.some(
          ([sql]) =>
            sql.includes("status='FAILED'") ||
            sql.includes("status = 'FAILED'"),
        ),
      ).toBe(false);
      expect(
        query.mock.calls.some(([sql]) => sql.includes('failure_reason=$2')),
      ).toBe(true);
      expect(
        query.mock.calls.some(([sql]) => sql.includes('claim_token=NULL')),
      ).toBe(true);
    });
    it('prevents a stale worker from overwriting a later outcome', async () => {
      const { query, internal, action } = setup(false);
      await internal.execute(action);
      expect(
        query.mock.calls.some(([sql]) => sql.includes('failure_reason=')),
      ).toBe(false);
    });
    it('records a definitive provider rejection as failed', async () => {
      const { query, circle, internal, action } = setup();
      circle.getTransaction.mockResolvedValue({ state: 'DENIED' });
      await internal.execute(action);
      expect(
        query.mock.calls.some(
          ([sql]) =>
            sql.includes("status='FAILED'") ||
            sql.includes("status = 'FAILED'"),
        ),
      ).toBe(true);
    });
  },
);
