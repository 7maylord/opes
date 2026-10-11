import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import { DocumentStorageService } from './document-storage.service';
import { EvidenceService } from './evidence.service';
import type { RecordEvidenceDocumentRequest } from './evidence.service';
import { RailwayBucketService } from './railway-bucket.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};
const documentId = '55555555-5555-4555-8555-555555555555';
const bytes = new TextEncoder().encode('verified invoice');
const sha256Hex = createHash('sha256').update(bytes).digest('hex');

function document(status = 'STAGING') {
  return {
    id: documentId,
    document_type: 'INVOICE',
    filename: 'invoice.txt',
    content_type: 'text/plain',
    size_bytes: bytes.length,
    sha256_hex: sha256Hex,
    storage_key: `staging/${context.organizationId}/upload`,
    status,
    metadata: {},
  };
}

function createService(
  query: TenantDatabase['query'],
  bucket: Partial<RailwayBucketService>,
  evidence: Partial<EvidenceService> = {},
) {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new DocumentStorageService(
    { withTenant } as unknown as DatabaseService,
    evidence as EvidenceService,
    { isConfigured: () => true, ...bucket } as RailwayBucketService,
  );
}

describe('DocumentStorageService', () => {
  it('generates the staging key and never accepts one from the caller', async () => {
    let recorded: RecordEvidenceDocumentRequest | undefined;
    const recordEvidenceDocument = jest.fn(
      (_context: TenantContext, input: RecordEvidenceDocumentRequest) => {
        recorded = input;
        return Promise.resolve({
          id: documentId,
          documentType: 'INVOICE',
          filename: 'invoice.txt',
          contentType: 'text/plain',
          sizeBytes: bytes.length,
          sha256Hex,
          storageKey: 'generated-key',
          status: 'STAGING',
          metadata: {},
        });
      },
    );
    const createUploadUrl = jest.fn().mockResolvedValue({
      url: 'https://bucket.example/upload',
      headers: { 'content-type': 'text/plain' },
    });
    const service = createService(
      jest.fn(),
      { createUploadUrl },
      {
        recordEvidenceDocument,
      },
    );

    await expect(
      service.initiateUpload(context, {
        documentType: 'INVOICE',
        filename: 'invoice.txt',
        contentType: 'text/plain',
        sizeBytes: bytes.length,
        sha256Hex,
      }),
    ).resolves.toMatchObject({ uploadUrl: 'https://bucket.example/upload' });
    expect(recorded?.storageKey).toMatch(
      new RegExp(`^staging/${context.organizationId}/`),
    );
  });

  it('finalizes only bytes matching the declared size, type and hash', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [document()] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...document('VERIFIED'),
            storage_key: `documents/${context.organizationId}/${documentId}/${sha256Hex}`,
          },
        ],
      });
    const finalize = jest.fn().mockResolvedValue(undefined);
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const service = createService(query, {
      read: jest.fn().mockResolvedValue({
        bytes,
        contentType: 'text/plain',
        sizeBytes: bytes.length,
      }),
      finalize,
      delete: deleteObject,
    });

    await expect(
      service.finalizeUpload(context, documentId),
    ).resolves.toMatchObject({ status: 'VERIFIED', sha256Hex });
    expect(finalize).toHaveBeenCalledWith(
      document().storage_key,
      `documents/${context.organizationId}/${documentId}/${sha256Hex}`,
    );
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'VERIFIED'"),
      expect.any(Array),
    );
    expect(deleteObject).toHaveBeenCalledWith(document().storage_key);
  });

  it('rejects changed bytes before creating an immutable object', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [document()] });
    const finalize = jest.fn();
    const service = createService(query, {
      read: jest.fn().mockResolvedValue({
        bytes: new TextEncoder().encode('changed invoice'),
        contentType: 'text/plain',
        sizeBytes: bytes.length,
      }),
      finalize,
    });

    await expect(service.finalizeUpload(context, documentId)).rejects.toThrow(
      BadRequestException,
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
