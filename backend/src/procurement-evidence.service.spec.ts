import { DatabaseService, TenantDatabase } from './database.service';
import { ProcurementEvidenceService } from './procurement-evidence.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  membershipId: '33333333-3333-4333-8333-333333333333',
  agentId: '44444444-4444-4444-8444-444444444444',
  role: 'APPROVER',
  requestId: 'match-test',
};
const invoiceId = '55555555-5555-4555-8555-555555555555';
const obligationId = '66666666-6666-4666-8666-666666666666';
const governingId = '77777777-7777-4777-8777-777777777777';
const deliveryId = '88888888-8888-4888-8888-888888888888';
const vendorId = '99999999-9999-4999-8999-999999999999';

function serviceWithQuery(query: TenantDatabase['query']) {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new ProcurementEvidenceService({
    withTenant,
  } as unknown as DatabaseService);
}

function invoice(addressStatus = 'VERIFIED_ACTIVE') {
  return {
    id: invoiceId,
    obligation_id: obligationId,
    vendor_id: vendorId,
    vendor_address_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    currency: 'USDC',
    amount_atomic: '1000000',
    line_items: [
      {
        description: 'Catering',
        quantityMicros: '1000000',
        amountAtomic: '1000000',
      },
    ],
    status: 'PENDING_MATCH',
    obligation_status: 'PENDING_MATCH',
    address_status: addressStatus,
  };
}

function source(id: string, type: string) {
  return {
    id,
    evidence_type: type,
    vendor_id: vendorId,
    source_reference: `${type}-1`,
  };
}

function version(
  id: string,
  sourceId: string,
  governingSourceId: string | null,
) {
  return {
    id: sourceId,
    version_id: id,
    version: 1,
    status: 'ACTIVE',
    currency: 'USDC',
    total_amount_atomic: '2000000',
    tolerance_bps: 0,
    line_items: [
      {
        description: 'Catering',
        quantityMicros: '2000000',
        amountAtomic: '2000000',
      },
    ],
    governing_source_id: governingSourceId,
    evidence_document_id: null,
    external_accounting_record_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
}

it('accepts and accrues only after deterministic evidence matching passes', async () => {
  const queryMock = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [invoice()] })
    .mockResolvedValueOnce({ rows: [source(governingId, 'PURCHASE_ORDER')] })
    .mockResolvedValueOnce({
      rows: [
        version('cccccccc-cccc-4ccc-8ccc-cccccccccccc', governingId, null),
      ],
    })
    .mockResolvedValueOnce({ rows: [source(deliveryId, 'PURCHASE_RECEIPT')] })
    .mockResolvedValueOnce({
      rows: [
        version(
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          deliveryId,
          governingId,
        ),
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          invoice_version_id: invoiceId,
          status: 'PASS',
          reasons: [],
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          version_id: invoiceId,
          obligation_id: obligationId,
          vendor_id: vendorId,
          currency: 'USDC',
          amount_atomic: '1000000',
          status: 'ACCEPTED',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
  const query = queryMock as unknown as TenantDatabase['query'];

  await expect(
    serviceWithQuery(query).matchInvoice(
      context,
      invoiceId,
      governingId,
      deliveryId,
    ),
  ).resolves.toMatchObject({ status: 'PASS', reasons: [] });
  expect(
    queryMock.mock.calls.some(([text]) =>
      String(text).includes('INSERT INTO opes.ledger_entries'),
    ),
  ).toBe(true);
});

it('persists typed blockers and does not accrue a failed match', async () => {
  const lowCapacity = {
    ...version('cccccccc-cccc-4ccc-8ccc-cccccccccccc', governingId, null),
    total_amount_atomic: '500000',
  };
  const queryMock = jest
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [invoice('SUPERSEDED')] })
    .mockResolvedValueOnce({ rows: [source(governingId, 'PURCHASE_ORDER')] })
    .mockResolvedValueOnce({ rows: [lowCapacity] })
    .mockResolvedValueOnce({ rows: [source(deliveryId, 'PURCHASE_RECEIPT')] })
    .mockResolvedValueOnce({
      rows: [
        version(
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          deliveryId,
          governingId,
        ),
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          invoice_version_id: invoiceId,
          status: 'BLOCKED',
          reasons: ['PAYOUT_ADDRESS_CHANGED', 'GOVERNING_TOTAL_EXCEEDED'],
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
  const query = queryMock as unknown as TenantDatabase['query'];

  const result = await serviceWithQuery(query).matchInvoice(
    context,
    invoiceId,
    governingId,
    deliveryId,
  );
  expect(result.status).toBe('BLOCKED');
  expect(result.reasons).toEqual(
    expect.arrayContaining([
      'PAYOUT_ADDRESS_CHANGED',
      'GOVERNING_TOTAL_EXCEEDED',
    ]),
  );
  expect(
    queryMock.mock.calls.some(([text]) =>
      String(text).includes('INSERT INTO opes.ledger_entries'),
    ),
  ).toBe(false);
});

it('creates an immutable revocation version and blocks matched unpaid obligations', async () => {
  const current = {
    ...source(governingId, 'PURCHASE_ORDER'),
    ...version('cccccccc-cccc-4ccc-8ccc-cccccccccccc', governingId, null),
  };
  const queryMock = jest
    .fn()
    .mockResolvedValueOnce({
      rows: [source(governingId, 'PURCHASE_ORDER')],
    })
    .mockResolvedValueOnce({ rows: [current] })
    .mockResolvedValueOnce({
      rows: [
        {
          ...current,
          version_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          version: 2,
          status: 'REVOKED',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
  const query = queryMock as unknown as TenantDatabase['query'];

  await expect(
    serviceWithQuery(query).revoke(context, governingId),
  ).resolves.toMatchObject({ version: 2, status: 'REVOKED' });
  expect(
    queryMock.mock.calls.some(([text]) =>
      String(text).includes("SET status='BLOCKED'"),
    ),
  ).toBe(true);
});
