import { BadRequestException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { EvidenceService } from './evidence.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

function serviceWithQuery(query: TenantDatabase['query']): {
  service: EvidenceService;
  withTenant: jest.Mock;
} {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return {
    service: new EvidenceService({ withTenant } as unknown as DatabaseService),
    withTenant,
  };
}

describe('EvidenceService', () => {
  it('records immutable evidence document metadata with normalized hashes', async () => {
    const row = {
      id: 'document-1',
      document_type: 'INVOICE',
      filename: 'invoice.pdf',
      content_type: 'application/pdf',
      size_bytes: 1200,
      sha256_hex:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      storage_key: 'org/documents/invoice.pdf',
      status: 'STAGING',
      metadata: { source: 'upload' },
    };
    let intakeHash = '';
    const query = jest.fn(
      (
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: unknown[] }> => {
        if (text.includes('INSERT INTO opes.intake_envelopes')) {
          intakeHash = String(values?.[2]);
          return Promise.resolve({ rows: [] });
        }
        if (text.includes('FROM opes.intake_envelopes')) {
          return Promise.resolve({
            rows: [
              {
                id: 'envelope-1',
                payload_hash: intakeHash,
                document_id: null,
                status: 'RECEIVED',
              },
            ],
          });
        }
        if (
          text.includes('FROM opes.evidence_documents') &&
          text.includes('sha256_hex')
        ) {
          return Promise.resolve({ rows: [] });
        }
        if (text.includes('INSERT INTO opes.evidence_documents')) {
          return Promise.resolve({ rows: [row] });
        }
        return Promise.resolve({ rows: [] });
      },
    );
    const { service, withTenant } = serviceWithQuery(query);

    await expect(
      service.recordEvidenceDocument(context, {
        documentType: 'INVOICE',
        filename: 'invoice.pdf',
        contentType: 'APPLICATION/PDF',
        sizeBytes: 1200,
        sha256Hex: 'A'.repeat(64),
        storageKey: 'org/documents/invoice.pdf',
        metadata: { source: 'upload' },
      }),
    ).resolves.toEqual({
      id: 'document-1',
      documentType: 'INVOICE',
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1200,
      sha256Hex: 'a'.repeat(64),
      storageKey: 'org/documents/invoice.pdf',
      status: 'STAGING',
      metadata: { source: 'upload' },
    });
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO opes.evidence_documents'),
      [
        context.organizationId,
        'INVOICE',
        'invoice.pdf',
        'application/pdf',
        1200,
        'a'.repeat(64),
        'org/documents/invoice.pdf',
        JSON.stringify({ source: 'upload' }),
        context.membershipId,
      ],
    );
  });

  it('rejects oversized documents before opening tenant scope', async () => {
    const withTenant = jest.fn();
    const service = new EvidenceService({
      withTenant,
    } as unknown as DatabaseService);

    await expect(
      service.recordEvidenceDocument(context, {
        documentType: 'INVOICE',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 15 * 1024 * 1024 + 1,
        sha256Hex: 'a'.repeat(64),
        storageKey: 'org/documents/invoice.pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('returns the original document when an intake event is replayed', async () => {
    const row = {
      id: 'document-1',
      document_type: 'INVOICE',
      filename: 'invoice.pdf',
      content_type: 'application/pdf',
      size_bytes: 1200,
      sha256_hex: 'a'.repeat(64),
      storage_key: 'org/documents/invoice.pdf',
      status: 'STAGING',
      metadata: {},
    };
    let intakeHash = '';
    const query = jest.fn((text: string, values?: readonly unknown[]) => {
      if (text.includes('INSERT INTO opes.intake_envelopes')) {
        intakeHash = String(values?.[2]);
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM opes.intake_envelopes')) {
        return Promise.resolve({
          rows: [
            {
              id: 'envelope-1',
              payload_hash: intakeHash,
              document_id: row.id,
              status: 'STAGED',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [row] });
    });
    const { service } = serviceWithQuery(query);

    await expect(
      service.recordEvidenceDocument(context, {
        documentType: 'INVOICE',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1200,
        sha256Hex: 'a'.repeat(64),
        storageKey: 'ignored-new-staging-key',
      }),
    ).resolves.toMatchObject({ id: row.id, storageKey: row.storage_key });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('INSERT INTO opes.evidence_documents'),
      ),
    ).toBe(false);
  });

  it('quarantines a replay whose immutable payload changed', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'envelope-1',
            payload_hash: 'b'.repeat(64),
            document_id: null,
            status: 'STAGED',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { service } = serviceWithQuery(query);

    await expect(
      service.recordEvidenceDocument(context, {
        documentType: 'INVOICE',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1200,
        sha256Hex: 'a'.repeat(64),
        storageKey: 'staging/key',
      }),
    ).rejects.toThrow('Intake event was quarantined');
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'QUARANTINED'"),
      [context.organizationId, 'envelope-1'],
    );
  });

  it('rejects extraction output that tries to invoke tools', async () => {
    const withTenant = jest.fn();
    const service = new EvidenceService({
      withTenant,
    } as unknown as DatabaseService);

    await expect(
      service.recordDocumentExtraction(
        context,
        '55555555-5555-5555-5555-555555555555',
        {
          schemaName: 'invoice.v1',
          schemaVersion: '1',
          modelProvider: 'fixture',
          modelName: 'fixture',
          sourceSha256Hex: 'b'.repeat(64),
          output: { invoiceNumber: 'INV-1', tool_calls: [] },
        },
      ),
    ).rejects.toThrow('extraction output cannot contain tool calls');
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('holds low-confidence extracted claims for human review', async () => {
    const extraction = {
      id: '88888888-8888-8888-8888-888888888888',
      document_id: '55555555-5555-5555-5555-555555555555',
      schema_name: 'invoice',
      schema_version: '2',
      model_provider: 'deepseek',
      model_name: 'deepseek-flash',
      source_sha256_hex: 'a'.repeat(64),
      output: {
        vendorName: 'Acme',
        invoiceNumber: 'INV-1',
        currency: 'USDC',
        amount: '1.00',
        provenance: Object.fromEntries(
          ['vendorName', 'invoiceNumber', 'currency', 'amount'].map((field) => [
            field,
            { page: 1, excerpt: field, confidence: 80 },
          ]),
        ),
      },
      status: 'ACCEPTED',
    };
    const query = jest.fn((text: string, values?: readonly unknown[]) => {
      if (text.includes('INSERT INTO opes.document_extractions'))
        return Promise.resolve({ rows: [extraction] });
      if (text.includes('FROM opes.document_claim_versions')) {
        if (text.includes('MAX(version)'))
          return Promise.resolve({ rows: [{ next_version: 1 }] });
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('INSERT INTO opes.document_claim_versions'))
        return Promise.resolve({
          rows: [
            {
              id: '99999999-9999-9999-9999-999999999999',
              document_id: extraction.document_id,
              extraction_id: extraction.id,
              version: 1,
              claims: extraction.output,
              provenance: {},
              status: values?.[7],
            },
          ],
        });
      return Promise.resolve({ rows: [{ id: extraction.document_id }] });
    });
    const { service } = serviceWithQuery(query);

    await expect(
      service.recordDocumentExtraction(context, extraction.document_id, {
        schemaName: 'invoice',
        schemaVersion: '2',
        modelProvider: 'deepseek',
        modelName: 'deepseek-flash',
        sourceSha256Hex: 'a'.repeat(64),
        output: extraction.output,
      }),
    ).resolves.toMatchObject({ reviewStatus: 'PENDING_REVIEW' });
  });

  it('holds the vendor when a new payout address replaces an active address', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = jest
      .fn()
      .mockImplementation((text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes('FROM opes.vendors')) {
          return Promise.resolve({ rows: [{ id: 'vendor-1' }] });
        }
        if (text.includes("status = 'VERIFIED_ACTIVE'")) {
          return Promise.resolve({ rows: [{ id: 'address-1', version: 1 }] });
        }
        if (text.includes('INSERT INTO opes.vendor_payout_addresses')) {
          return Promise.resolve({
            rows: [
              {
                id: 'address-2',
                vendor_id: '55555555-5555-5555-5555-555555555555',
                environment: 'arc-testnet',
                chain_id: 5042002,
                asset_symbol: 'USDC',
                asset_address: '0x0000000000000000000000000000000000000001',
                payout_address: '0x0000000000000000000000000000000000000002',
                status: 'PENDING_REVIEW',
                version: 2,
                replaces_address_id: 'address-1',
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      });
    const { service } = serviceWithQuery(query);

    await expect(
      service.addVendorAddress(
        context,
        '55555555-5555-5555-5555-555555555555',
        {
          environment: 'arc-testnet',
          chainId: 5042002,
          assetSymbol: 'usdc',
          assetAddress: '0x0000000000000000000000000000000000000001',
          payoutAddress: '0x0000000000000000000000000000000000000002',
        },
      ),
    ).resolves.toMatchObject({
      id: 'address-2',
      status: 'PENDING_REVIEW',
      version: 2,
      replacesAddressId: 'address-1',
    });
    expect(queries[3]?.text).toContain("status = 'ADDRESS_REVIEW'");
    expect(queries[4]?.text).toContain('INSERT INTO opes.audit_events');
  });
});
