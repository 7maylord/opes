import { UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import {
  EmailInboxService,
  verifyResendSignature,
  workspaceInboxAddress,
} from './email-inbox.service';
import { EvidenceService } from './evidence.service';
import { RailwayBucketService } from './railway-bucket.service';

const secret = `whsec_${Buffer.from('resend-test-secret-32-bytes-long!').toString('base64')}`;
const timestamp = Math.floor(Date.now() / 1000).toString();
const inbox = {
  id: '11111111-1111-4111-8111-111111111111',
  organization_id: '22222222-2222-4222-8222-222222222222',
  address: 'invoices@opes.test',
  status: 'ACTIVE',
  membership_id: '33333333-3333-4333-8333-333333333333',
  user_id: '44444444-4444-4444-8444-444444444444',
  agent_id: '55555555-5555-4555-8555-555555555555',
  role: 'OWNER',
};

function payload(attachmentIds = ['attachment-b', 'attachment-a']) {
  return {
    type: 'email.received',
    created_at: '2026-10-15T00:00:00.000Z',
    data: {
      email_id: '66666666-6666-4666-8666-666666666666',
      created_at: '2026-10-15T00:00:00.000Z',
      from: 'Vendor Billing <billing@vendor.example>',
      to: [inbox.address],
      bcc: [],
      cc: [],
      message_id: '<invoice-1@vendor.example>',
      subject: 'Invoice 1',
      attachments: attachmentIds.map((id) => ({
        id,
        filename: `${id}.txt`,
        content_type: 'text/plain',
        content_disposition: 'attachment',
      })),
    },
  };
}

function signed(value: unknown, id = 'msg_test') {
  const raw = Buffer.from(JSON.stringify(value));
  const key = Buffer.from(secret.slice(6), 'base64');
  const signature = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]))
    .digest('base64');
  return {
    raw,
    headers: { id, timestamp, signature: `v1,${signature}` },
  };
}

function databaseMock(resolvedInboxes = [inbox]) {
  let event:
    | {
        id: string;
        provider_event_id: string;
        provider_email_id: string;
        payload_hash: string;
        status: string;
        document_count: number;
      }
    | undefined;
  const queries: string[] = [];
  const query = jest.fn((text: string, values?: readonly unknown[]) => {
    queries.push(text);
    if (text.includes('FROM opes.email_inboxes'))
      return Promise.resolve({ rows: resolvedInboxes });
    if (text.includes('INSERT INTO opes.inbound_email_events')) {
      event ??= {
        id: 'event-row',
        provider_event_id: String(values?.[2]),
        provider_email_id: String(values?.[3]),
        payload_hash: String(values?.[4]),
        status: String(values?.[8]),
        document_count: 0,
      };
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('FROM opes.inbound_email_events'))
      return Promise.resolve({ rows: event ? [event] : [] });
    if (text.includes("status='PROCESSING'")) {
      if (event) event.status = 'PROCESSING';
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("status='FAILED'")) {
      if (event) event.status = 'FAILED';
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('status=$2')) {
      if (event) {
        event.status = String(values?.[1]);
        event.document_count = Number(values?.[2]);
      }
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const run = (work: (database: TenantDatabase) => unknown) => work({ query });
  return {
    database: {
      withWorker: run,
      withTenant: (
        _context: unknown,
        work: (database: TenantDatabase) => unknown,
      ) => run(work),
      withOrganizationScope: (
        _organizationId: string,
        work: (database: TenantDatabase) => unknown,
      ) => run(work),
    } as unknown as DatabaseService,
    queries,
  };
}

function service(
  extraction: jest.Mock = jest.fn().mockResolvedValue({}),
  resolvedInboxes = [inbox],
) {
  const { database, queries } = databaseMock(resolvedInboxes);
  const recordEvidenceDocument = jest.fn(
    (_context, input: { sha256Hex: string; filename: string }) =>
      Promise.resolve({
        id: `document-${input.filename}`,
        status: 'STAGING',
        sha256Hex: input.sha256Hex,
      }),
  );
  const write = jest.fn().mockResolvedValue(undefined);
  return {
    inboxes: new EmailInboxService(
      database,
      { recordEvidenceDocument } as unknown as EvidenceService,
      {
        finalizeUpload: jest.fn((_context, id: string) =>
          Promise.resolve({ id, status: 'VERIFIED' }),
        ),
      } as unknown as DocumentStorageService,
      { extractInvoice: extraction } as unknown as DocumentExtractionService,
      {
        write,
        delete: jest.fn().mockResolvedValue(undefined),
      } as unknown as RailwayBucketService,
    ),
    recordEvidenceDocument,
    write,
    queries,
  };
}

describe('EmailInboxService', () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.OPES_RESEND_WEBHOOK_SECRET;
  const originalApiKey = process.env.OPES_RESEND_API_KEY;
  const originalInboundDomain = process.env.OPES_INBOUND_EMAIL_DOMAIN;

  beforeEach(() => {
    process.env.OPES_RESEND_WEBHOOK_SECRET = secret;
    process.env.OPES_RESEND_API_KEY = 're_test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSecret === undefined)
      delete process.env.OPES_RESEND_WEBHOOK_SECRET;
    else process.env.OPES_RESEND_WEBHOOK_SECRET = originalSecret;
    if (originalApiKey === undefined) delete process.env.OPES_RESEND_API_KEY;
    else process.env.OPES_RESEND_API_KEY = originalApiKey;
    if (originalInboundDomain === undefined)
      delete process.env.OPES_INBOUND_EMAIL_DOMAIN;
    else process.env.OPES_INBOUND_EMAIL_DOMAIN = originalInboundDomain;
  });

  it('accepts a preferred address only on the inbound domain', () => {
    process.env.OPES_INBOUND_EMAIL_DOMAIN = 'mail.maylord.xyz';
    expect(workspaceInboxAddress(' Accounts@MAIL.MAYLORD.XYZ ')).toBe(
      'accounts@mail.maylord.xyz',
    );
    expect(() => workspaceInboxAddress('accounts@gmail.com')).toThrow(
      'address must use mail.maylord.xyz',
    );
  });

  it('rejects forged webhook signatures before database access', () => {
    const { raw, headers } = signed(payload());
    expect(() =>
      verifyResendSignature(
        raw,
        { ...headers, signature: 'v1,Zm9yZ2Vk' },
        secret,
        Number(timestamp) * 1000,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('quarantines a signed email for an unknown recipient alias', async () => {
    const { inboxes } = service(jest.fn(), []);
    const event = signed(payload());
    await expect(
      inboxes.ingestWebhook(event.raw, event.headers),
    ).resolves.toEqual({ status: 'QUARANTINED', documents: 0, replay: false });
  });

  it('ingests attachments once when a signed replay reorders them', async () => {
    const { inboxes, recordEvidenceDocument, write, queries } = service();
    mockResendFetch();
    const first = signed(payload());
    await expect(
      inboxes.ingestWebhook(first.raw, first.headers),
    ).resolves.toEqual({ status: 'PROCESSED', documents: 2, replay: false });
    const replay = signed(payload(['attachment-a', 'attachment-b']));
    await expect(
      inboxes.ingestWebhook(replay.raw, replay.headers),
    ).resolves.toEqual({ status: 'PROCESSED', documents: 2, replay: true });

    expect(write).toHaveBeenCalledTimes(2);
    expect(recordEvidenceDocument).toHaveBeenCalledTimes(2);
    const recorded = recordEvidenceDocument.mock.calls.find(
      (call) =>
        (call[1] as { filename: string }).filename === 'attachment-a.txt',
    );
    const recordedInput = recorded?.[1] as {
      sha256Hex: string;
      metadata: {
        senderEvidence: { trustedForVendorOrPayoutAuthority: boolean };
      };
    };
    expect(recordedInput.sha256Hex).toBe(
      createHash('sha256').update('attachment-a bytes').digest('hex'),
    );
    expect(
      recordedInput.metadata.senderEvidence.trustedForVendorOrPayoutAuthority,
    ).toBe(false);
    expect(recorded?.[2]).toEqual({ sourceType: 'EMAIL', automated: true });
    expect(queries.some((text) => text.includes('opes.vendors'))).toBe(false);
    expect(queries.some((text) => text.includes('vendor_payout'))).toBe(false);
    expect(queries.some((text) => text.includes("'previewText'"))).toBe(true);
  });

  it('reuses the same attachment hash after extraction failure and retry', async () => {
    const extraction = jest
      .fn()
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValue({});
    const { inboxes, recordEvidenceDocument } = service(extraction);
    mockResendFetch(['attachment-a']);
    const event = signed(payload(['attachment-a']));
    await expect(
      inboxes.ingestWebhook(event.raw, event.headers),
    ).rejects.toThrow('model unavailable');
    mockResendFetch(['attachment-a']);
    await expect(
      inboxes.ingestWebhook(event.raw, event.headers),
    ).resolves.toEqual({ status: 'PROCESSED', documents: 1, replay: false });
    const hashes = recordEvidenceDocument.mock.calls.map(
      (call) => (call[1] as { sha256Hex: string }).sha256Hex,
    );
    expect(hashes).toEqual([hashes[0], hashes[0]]);
  });
});

function mockResendFetch(ids = ['attachment-a', 'attachment-b']) {
  const received = payload(ids).data;
  global.fetch = jest.fn((input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith('https://download.test/')) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      return Promise.resolve(new Response(`${id} bytes`, { status: 200 }));
    }
    const attachment = ids.find((id) => url.endsWith(`/${id}`));
    if (attachment)
      return Promise.resolve(
        Response.json({
          id: attachment,
          filename: `${attachment}.txt`,
          content_type: 'text/plain',
          content_disposition: 'attachment',
          download_url: `https://download.test/${attachment}`,
          expires_at: '2026-10-16T00:00:00.000Z',
        }),
      );
    return Promise.resolve(
      Response.json({
        id: received.email_id,
        from: received.from,
        to: received.to,
        message_id: received.message_id,
        subject: received.subject,
        text: 'Please review the attached invoice.',
        headers: {
          'Authentication-Results': 'spf=pass; dkim=pass',
          'Return-Path': '<billing@vendor.example>',
        },
        attachments: received.attachments,
      }),
    );
  }) as typeof fetch;
}
