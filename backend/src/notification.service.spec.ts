import { TenantDatabase } from './database.service';
import { recordPaymentSettlementCommunications } from './notification.service';

function result(rows: Array<Record<string, unknown>>) {
  return Promise.resolve({
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  });
}

it('records settlement once and queues supplier advice only after confirmed payment evidence', async () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const query = jest.fn((text: string, values?: readonly unknown[]) => {
    queries.push({ text, values });
    if (text.includes('FROM opes.payment_executions execution'))
      return result([
        {
          invoice_number: 'INV-100',
          amount_atomic: '1250000',
          asset_symbol: 'USDC',
          vendor_name: 'Canteen Supplies',
          recipient_email: 'billing@canteen.test',
          transaction_hash: `0x${'a'.repeat(64)}`,
        },
      ]);
    if (text.includes('RETURNING id'))
      return result([{ id: '33333333-3333-3333-3333-333333333333' }]);
    return result([]);
  });

  await recordPaymentSettlementCommunications(
    { query } as TenantDatabase,
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
  );

  expect(
    queries.some((item) => item.text.includes('opes.workspace_notifications')),
  ).toBe(true);
  expect(
    queries.some((item) =>
      item.text.includes('opes.outbound_email_deliveries'),
    ),
  ).toBe(true);
  expect(
    queries.some((item) => item.text.includes("'PAYMENT_ADVICE_EMAIL'")),
  ).toBe(true);
  expect(JSON.stringify(queries)).toContain('Invoice INV-100 settled');
});
