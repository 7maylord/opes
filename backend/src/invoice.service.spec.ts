import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { InvoiceService } from './invoice.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

const validRequest = {
  vendorId: '55555555-5555-5555-5555-555555555555',
  vendorAddressId: '66666666-6666-6666-6666-666666666666',
  evidenceDocumentId: '77777777-7777-7777-7777-777777777777',
  extractionId: '88888888-8888-8888-8888-888888888888',
  invoiceNumber: 'INV-1042',
  currency: 'USDC' as const,
  amount: '12.340001',
  lineItems: [
    { description: 'Design', amount: '10.000001' },
    { description: 'Support', amount: '2.34' },
  ],
};

function serviceWithQuery(query: TenantDatabase['query']): InvoiceService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new InvoiceService({ withTenant } as unknown as DatabaseService);
}

function queryReturningHappyPath() {
  return jest
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          id: validRequest.vendorId,
          status: 'VERIFIED',
          display_name: 'Atlas Studio',
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: validRequest.vendorAddressId,
          vendor_id: validRequest.vendorId,
          status: 'VERIFIED_ACTIVE',
          asset_symbol: 'USDC',
          payout_address: '0x0000000000000000000000000000000000000002',
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: validRequest.evidenceDocumentId,
          document_type: 'INVOICE',
          sha256_hex:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: validRequest.extractionId,
          document_id: validRequest.evidenceDocumentId,
          source_sha256_hex:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          output: {
            vendorName: 'Atlas Studio',
            invoiceNumber: 'INV-1042',
            currency: 'USDC',
            totalAmount: '12.340001',
            payoutAddress: '0x0000000000000000000000000000000000000002',
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [{ id: '99999999-9999-9999-9999-999999999999' }],
    })
    .mockResolvedValueOnce({ rows: [{ next_version: 1 }] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          version: 1,
          status: 'ACCEPTED',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          version_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          obligation_id: '99999999-9999-9999-9999-999999999999',
          vendor_id: validRequest.vendorId,
          currency: 'USDC',
          amount_atomic: '12340001',
          status: 'ACCEPTED',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
}

describe('InvoiceService', () => {
  it('verifies an invoice using six-decimal atomic arithmetic', async () => {
    const query = queryReturningHappyPath();
    const service = serviceWithQuery(query);

    await expect(
      service.verifyInvoice(context, validRequest),
    ).resolves.toMatchObject({
      version: 1,
      invoiceNumber: 'INV-1042',
      currency: 'USDC',
      amountAtomic: '12340001',
      amountDecimals: 6,
      status: 'ACCEPTED',
    });
    expect(query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining('INSERT INTO opes.payable_obligation_versions'),
      expect.arrayContaining(['12340001']),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO opes.ledger_entries'),
      expect.arrayContaining(['INVOICE_ACCEPTED', '12340001']),
    );
  });

  it('rejects precision loss before opening tenant scope', async () => {
    const withTenant = jest.fn();
    const service = new InvoiceService({
      withTenant,
    } as unknown as DatabaseService);

    await expect(
      service.verifyInvoice(context, {
        ...validRequest,
        amount: '1.0000001',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects invoices whose line items do not sum to the total', async () => {
    const withTenant = jest.fn();
    const service = new InvoiceService({
      withTenant,
    } as unknown as DatabaseService);

    await expect(
      service.verifyInvoice(context, {
        ...validRequest,
        amount: '12.34',
      }),
    ).rejects.toThrow('line item total does not match amount');
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('rejects extraction claims that point at a different payee', async () => {
    const query = queryReturningHappyPath();
    query.mockReset();
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorId,
            status: 'VERIFIED',
            display_name: 'Atlas Studio',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorAddressId,
            vendor_id: validRequest.vendorId,
            status: 'VERIFIED_ACTIVE',
            asset_symbol: 'USDC',
            payout_address: '0x0000000000000000000000000000000000000002',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.evidenceDocumentId,
            document_type: 'INVOICE',
            sha256_hex:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.extractionId,
            document_id: validRequest.evidenceDocumentId,
            source_sha256_hex:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            output: {
              payoutAddress: '0x0000000000000000000000000000000000000009',
            },
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(service.verifyInvoice(context, validRequest)).rejects.toThrow(
      'Extraction payoutAddress does not match invoice',
    );
  });

  it('rejects inactive vendor payout addresses', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorId,
            status: 'VERIFIED',
            display_name: 'Atlas Studio',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorAddressId,
            vendor_id: validRequest.vendorId,
            status: 'PENDING_REVIEW',
            asset_symbol: 'USDC',
            payout_address: '0x0000000000000000000000000000000000000002',
          },
        ],
      });
    const service = serviceWithQuery(query);

    await expect(service.verifyInvoice(context, validRequest)).rejects.toThrow(
      'Vendor payout address is not active',
    );
  });

  it('maps duplicate immutable versions to a conflict', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorId,
            status: 'VERIFIED',
            display_name: 'Atlas Studio',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.vendorAddressId,
            vendor_id: validRequest.vendorId,
            status: 'VERIFIED_ACTIVE',
            asset_symbol: 'USDC',
            payout_address: '0x0000000000000000000000000000000000000002',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.evidenceDocumentId,
            document_type: 'INVOICE',
            sha256_hex:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: validRequest.extractionId,
            document_id: validRequest.evidenceDocumentId,
            source_sha256_hex:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            output: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: '99999999-9999-9999-9999-999999999999' }],
      })
      .mockResolvedValueOnce({ rows: [{ next_version: 2 }] })
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
    const service = serviceWithQuery(query);

    await expect(
      service.verifyInvoice(context, validRequest),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
