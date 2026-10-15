import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from './database.service';
import {
  assertDocumentContentType,
  MAX_DOCUMENT_BYTES,
} from './document-content';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import { EvidenceService } from './evidence.service';
import { RailwayBucketService } from './railway-bucket.service';
import { TenantContext } from './tenant-context';

const RESEND_API = 'https://api.resend.com';
const SUPPORTED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/json',
  'image/jpeg',
  'image/png',
  'text/csv',
  'text/plain',
]);

export interface ConfigureEmailInboxRequest {
  address: string;
}

export interface EmailInboxResponse {
  id: string;
  address: string;
  status: string;
}

export interface ResendWebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

interface InboxRow {
  id: string;
  organization_id: string;
  address: string;
  status: string;
  membership_id: string;
  user_id: string;
  agent_id: string;
  role: TenantContext['role'];
}

interface EventRow {
  id: string;
  provider_event_id: string;
  provider_email_id: string;
  payload_hash: string;
  status: string;
}

interface ResendAttachment {
  id: string;
  filename?: string | null;
  content_type?: string;
  content_disposition?: string | null;
  content_id?: string | null;
  size?: number;
}

interface ResendReceivedEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to: string[];
    bcc?: string[];
    cc?: string[];
    message_id: string;
    subject?: string | null;
    attachments?: ResendAttachment[];
  };
}

interface ResendReceivedEmail {
  id: string;
  from: string;
  to: string[];
  message_id: string;
  subject?: string | null;
  received_for?: string[];
  headers?: Record<string, string> | null;
  attachments?: ResendAttachment[];
}

interface RetrievedAttachment extends ResendAttachment {
  download_url: string;
  expires_at: string;
}

@Injectable()
export class EmailInboxService {
  constructor(
    private readonly database: DatabaseService,
    private readonly evidence: EvidenceService,
    private readonly documents: DocumentStorageService,
    private readonly extractions: DocumentExtractionService,
    private readonly bucket: RailwayBucketService,
  ) {}

  async configureInbox(
    context: TenantContext,
    input: ConfigureEmailInboxRequest,
  ): Promise<EmailInboxResponse> {
    requireManager(context);
    const address = normalizeEmail(input.address, 'address');
    try {
      return await this.database.withTenant(context, async (database) => {
        const result = await database.query<{
          id: string;
          address: string;
          status: string;
        }>(
          `INSERT INTO opes.email_inboxes
            (organization_id,address,status,created_by_membership_id)
           VALUES ($1,$2,'ACTIVE',$3)
           ON CONFLICT (organization_id) DO UPDATE SET
             address=EXCLUDED.address,status='ACTIVE',
             created_by_membership_id=EXCLUDED.created_by_membership_id,
             updated_at=now()
           RETURNING id,address,status`,
          [context.organizationId, address, context.membershipId],
        );
        return requireRow(result.rows[0], 'email inbox');
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('Inbound email address is already in use');
      throw error;
    }
  }

  async getInbox(context: TenantContext): Promise<EmailInboxResponse | null> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<{ id: string; address: string; status: string }>(
        `SELECT id,address,status FROM opes.email_inboxes
         WHERE organization_id=$1`,
        [context.organizationId],
      ),
    );
    return result.rows[0] ?? null;
  }

  async ingestWebhook(
    rawBody: Uint8Array,
    headers: ResendWebhookHeaders,
  ): Promise<{ status: string; documents: number; replay: boolean }> {
    const secret = process.env.OPES_RESEND_WEBHOOK_SECRET?.trim();
    if (!secret)
      throw new ServiceUnavailableException(
        'Resend webhook secret is not configured',
      );
    verifyResendSignature(rawBody, headers, secret);
    const event = parseEvent(rawBody);
    if (event.type !== 'email.received')
      return { status: 'IGNORED', documents: 0, replay: false };

    const payloadHash = semanticEventHash(event);
    const sender = parseMailbox(event.data.from);
    const recipients = event.data.to.map((value) =>
      normalizeEmail(parseMailbox(value).address, 'recipient'),
    );
    const inboxes = await this.resolveInboxes(recipients);
    const inbox = inboxes.length === 1 ? inboxes[0] : undefined;
    const quarantineReason =
      inboxes.length === 0
        ? 'UNKNOWN_RECIPIENT_ALIAS'
        : inboxes.length > 1
          ? 'AMBIGUOUS_RECIPIENT_ALIAS'
          : null;
    const claimed = await this.claimEvent({
      event,
      headers,
      payloadHash,
      sender,
      inbox,
      quarantineReason,
    });
    if (!claimed.process)
      return {
        status: claimed.status,
        documents: claimed.documents,
        replay: claimed.replay,
      };
    if (!inbox || quarantineReason)
      return { status: 'QUARANTINED', documents: 0, replay: false };

    try {
      const received = await this.resendJson<ResendReceivedEmail>(
        `/emails/receiving/${encodeURIComponent(event.data.email_id)}`,
      );
      validateReceivedEmail(received);
      if (!receivedEmailMatches(event, received, inbox.address)) {
        await this.finishEvent(
          claimed.id,
          'QUARANTINED',
          0,
          'RETRIEVED_EMAIL_MISMATCH',
        );
        return { status: 'QUARANTINED', documents: 0, replay: false };
      }

      const attachments = (received.attachments ?? event.data.attachments ?? [])
        .filter((attachment) => attachment.content_disposition !== 'inline')
        .sort((left, right) => left.id.localeCompare(right.id));
      const context = inboxContext(inbox, headers.id as string);
      let documents = 0;
      let quarantined = 0;
      for (const attachment of attachments) {
        const contentType = attachment.content_type?.toLowerCase();
        if (!contentType || !SUPPORTED_CONTENT_TYPES.has(contentType)) {
          await this.quarantineAttachment(
            context.organizationId,
            event.data.email_id,
            attachment,
            'UNSUPPORTED_ATTACHMENT_TYPE',
          );
          quarantined += 1;
          continue;
        }
        const retrieved = await this.resendJson<RetrievedAttachment>(
          `/emails/receiving/${encodeURIComponent(event.data.email_id)}/attachments/${encodeURIComponent(attachment.id)}`,
        );
        validateRetrievedAttachment(retrieved);
        if (
          retrieved.id !== attachment.id ||
          retrieved.content_type?.toLowerCase() !== contentType
        ) {
          await this.quarantineAttachment(
            context.organizationId,
            event.data.email_id,
            attachment,
            'ATTACHMENT_METADATA_MISMATCH',
          );
          quarantined += 1;
          continue;
        }
        const bytes = await downloadAttachment(retrieved.download_url);
        if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES)
          throw new BadRequestException('Inbound attachment size is invalid');
        assertDocumentContentType(bytes, contentType);
        const sha256Hex = createHash('sha256').update(bytes).digest('hex');
        const stagingKey = `staging/${context.organizationId}/email/${event.data.email_id}/${attachment.id}/${sha256Hex}`;
        await this.bucket.write(stagingKey, bytes, contentType, sha256Hex);
        try {
          const document = await this.evidence.recordEvidenceDocument(
            context,
            {
              documentType: 'INVOICE',
              filename: attachment.filename || `attachment-${attachment.id}`,
              contentType,
              sizeBytes: bytes.length,
              sha256Hex,
              storageKey: stagingKey,
              sourceEventId: `${event.data.email_id}:${attachment.id}`,
              metadata: {
                source: 'EMAIL',
                provider: 'resend',
                providerEmailId: event.data.email_id,
                providerAttachmentId: attachment.id,
                messageId: event.data.message_id,
                subject: event.data.subject ?? null,
                recipients,
                senderEvidence: {
                  declaredFrom: event.data.from,
                  address: sender.address,
                  domain: sender.domain,
                  authenticationResults: headerValue(
                    received.headers,
                    'authentication-results',
                  ),
                  returnPath: headerValue(received.headers, 'return-path'),
                  trustedForVendorOrPayoutAuthority: false,
                },
              },
            },
            { sourceType: 'EMAIL', automated: true },
          );
          const finalized = await this.documents.finalizeUpload(
            context,
            document.id,
          );
          await this.extractions.extractInvoice(context, finalized.id, true);
          documents += 1;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          quarantined += 1;
        } finally {
          await this.bucket.delete(stagingKey).catch(() => undefined);
        }
      }

      const status = documents > 0 ? 'PROCESSED' : 'QUARANTINED';
      const reason =
        documents === 0
          ? attachments.length === 0
            ? 'NO_ATTACHMENTS'
            : quarantined > 0
              ? 'NO_ACCEPTED_ATTACHMENTS'
              : 'NO_ATTACHMENTS'
          : null;
      await this.finishEvent(claimed.id, status, documents, reason);
      return { status, documents, replay: false };
    } catch (error) {
      await this.failEvent(claimed.id, error);
      throw error;
    }
  }

  private async resolveInboxes(recipients: string[]): Promise<InboxRow[]> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<InboxRow>(
        `SELECT inbox.id,inbox.organization_id,inbox.address,inbox.status,
            membership.id AS membership_id,membership.user_id,
            agent.id AS agent_id,membership.role
         FROM opes.email_inboxes inbox
         JOIN opes.organization_memberships membership
           ON membership.organization_id=inbox.organization_id
          AND membership.id=inbox.created_by_membership_id
         JOIN opes.business_agents agent
           ON agent.organization_id=inbox.organization_id AND agent.is_primary
         WHERE inbox.status='ACTIVE'
           AND inbox.address_normalized=ANY($1::text[])`,
        [recipients],
      );
      return result.rows;
    });
  }

  private async claimEvent(input: {
    event: ResendReceivedEvent;
    headers: ResendWebhookHeaders;
    payloadHash: string;
    sender: { address: string; domain: string };
    inbox: InboxRow | undefined;
    quarantineReason: string | null;
  }): Promise<{
    id: string;
    process: boolean;
    status: string;
    documents: number;
    replay: boolean;
  }> {
    return this.database.withWorker(async (database) => {
      await database.query(
        `INSERT INTO opes.inbound_email_events (
           organization_id,inbox_id,provider_event_id,provider_email_id,
           payload_hash,recipient_address,sender_address,sender_domain,
           status,quarantine_reason,raw_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          input.inbox?.organization_id ?? null,
          input.inbox?.id ?? null,
          input.headers.id,
          input.event.data.email_id,
          input.payloadHash,
          input.inbox?.address ?? null,
          input.sender.address,
          input.sender.domain,
          'RECEIVED',
          null,
          JSON.stringify({
            createdAt: input.event.created_at,
            messageId: input.event.data.message_id,
            subject: input.event.data.subject ?? null,
            from: input.event.data.from,
            to: input.event.data.to,
            attachmentIds: (input.event.data.attachments ?? []).map(
              (attachment) => attachment.id,
            ),
          }),
        ],
      );
      const existing = await database.query<
        EventRow & { document_count: number }
      >(
        `SELECT id,provider_event_id,provider_email_id,payload_hash,status,document_count
         FROM opes.inbound_email_events
         WHERE provider='resend'
           AND (provider_event_id=$1 OR provider_email_id=$2)
         ORDER BY received_at LIMIT 1 FOR UPDATE`,
        [input.headers.id, input.event.data.email_id],
      );
      const row = requireRow(existing.rows[0], 'inbound email event');
      if (
        row.provider_email_id !== input.event.data.email_id ||
        row.payload_hash !== input.payloadHash
      ) {
        await database.query(
          `UPDATE opes.inbound_email_events SET
             status='QUARANTINED',quarantine_reason='SOURCE_EVENT_PAYLOAD_MISMATCH',
             updated_at=now()
           WHERE id=$1`,
          [row.id],
        );
        return {
          id: row.id,
          process: false,
          status: 'QUARANTINED',
          documents: row.document_count,
          replay: true,
        };
      }
      if (row.status === 'PROCESSED' || row.status === 'QUARANTINED')
        return {
          id: row.id,
          process: false,
          status: row.status,
          documents: row.document_count,
          replay: true,
        };
      if (input.quarantineReason) {
        await database.query(
          `UPDATE opes.inbound_email_events SET
             status='QUARANTINED',quarantine_reason=$2,processed_at=now(),updated_at=now()
           WHERE id=$1`,
          [row.id, input.quarantineReason],
        );
        return {
          id: row.id,
          process: false,
          status: 'QUARANTINED',
          documents: 0,
          replay: false,
        };
      }
      await database.query(
        `UPDATE opes.inbound_email_events SET
           status='PROCESSING',failure_reason=NULL,updated_at=now()
         WHERE id=$1`,
        [row.id],
      );
      return {
        id: row.id,
        process: true,
        status: 'PROCESSING',
        documents: 0,
        replay: false,
      };
    });
  }

  private async quarantineAttachment(
    organizationId: string,
    emailId: string,
    attachment: ResendAttachment,
    reason: string,
  ): Promise<void> {
    const payloadHash = createHash('sha256')
      .update(semanticStringify(attachment))
      .digest('hex');
    await this.database.withOrganizationScope(organizationId, (database) =>
      database.query(
        `INSERT INTO opes.intake_envelopes (
           organization_id,source_type,source_event_id,payload_hash,status,
           quarantine_reason,raw_metadata
         ) VALUES ($1,'EMAIL',$2,$3,'QUARANTINED',$4,$5::jsonb)
         ON CONFLICT (organization_id,source_type,source_event_id)
         DO UPDATE SET updated_at=opes.intake_envelopes.updated_at`,
        [
          organizationId,
          `email:${emailId}:${attachment.id}`,
          payloadHash,
          reason,
          JSON.stringify(attachment),
        ],
      ),
    );
  }

  private async resendJson<T>(path: string): Promise<T> {
    const apiKey = process.env.OPES_RESEND_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceUnavailableException('Resend API key is not configured');
    const response = await fetch(`${RESEND_API}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException(
        `Resend API returned HTTP ${response.status}`,
      );
    return (await response.json()) as T;
  }

  private async finishEvent(
    eventId: string,
    status: string,
    documents: number,
    quarantineReason: string | null,
  ): Promise<void> {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.inbound_email_events SET status=$2,document_count=$3,
           quarantine_reason=$4,failure_reason=NULL,processed_at=now(),updated_at=now()
         WHERE id=$1`,
        [eventId, status, documents, quarantineReason],
      ),
    );
  }

  private async failEvent(eventId: string, error: unknown): Promise<void> {
    const reason =
      error instanceof Error ? error.message : 'Email intake failed';
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.inbound_email_events SET status='FAILED',failure_reason=$2,
           updated_at=now() WHERE id=$1`,
        [eventId, reason.slice(0, 1000)],
      ),
    );
  }
}

export function verifyResendSignature(
  rawBody: Uint8Array,
  headers: ResendWebhookHeaders,
  secret: string,
  now = Date.now(),
): void {
  if (!headers.id || !headers.timestamp || !headers.signature)
    throw new UnauthorizedException('Resend webhook signature is missing');
  const seconds = Number(headers.timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now - seconds * 1000) > 300_000)
    throw new UnauthorizedException('Resend webhook timestamp is invalid');
  const encodedSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(encodedSecret, 'base64');
  } catch {
    throw new ServiceUnavailableException('Resend webhook secret is invalid');
  }
  if (key.length === 0)
    throw new ServiceUnavailableException('Resend webhook secret is invalid');
  const message = Buffer.concat([
    Buffer.from(`${headers.id}.${headers.timestamp}.`),
    Buffer.from(rawBody),
  ]);
  const expected = createHmac('sha256', key).update(message).digest();
  const valid = headers.signature.split(' ').some((candidate) => {
    const [version, encoded] = candidate.split(',', 2);
    if (version !== 'v1' || !encoded) return false;
    const actual = Buffer.from(encoded, 'base64');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
  if (!valid)
    throw new UnauthorizedException('Resend webhook signature is invalid');
}

async function downloadAttachment(url: string): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ServiceUnavailableException('Resend attachment URL is invalid');
  }
  if (parsed.protocol !== 'https:')
    throw new ServiceUnavailableException('Resend attachment URL is invalid');
  const response = await fetch(parsed, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok)
    throw new ServiceUnavailableException(
      `Resend attachment download returned HTTP ${response.status}`,
    );
  const declaredSize = Number(response.headers.get('content-length') ?? '0');
  if (declaredSize > MAX_DOCUMENT_BYTES)
    throw new BadRequestException('Inbound attachment is too large');
  if (!response.body)
    throw new ServiceUnavailableException('Resend attachment body is missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new BadRequestException('Inbound attachment is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function parseEvent(rawBody: Uint8Array): ResendReceivedEvent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new BadRequestException('Resend webhook body is invalid JSON');
  }
  if (!plainObject(value) || typeof value.type !== 'string')
    throw new BadRequestException('Resend webhook event is invalid');
  if (value.type !== 'email.received')
    return value as unknown as ResendReceivedEvent;
  const data = value.data;
  const attachments = plainObject(data) ? data.attachments : undefined;
  if (
    !plainObject(data) ||
    typeof data.email_id !== 'string' ||
    data.email_id.length === 0 ||
    data.email_id.length > 100 ||
    typeof data.from !== 'string' ||
    !Array.isArray(data.to) ||
    !data.to.every((item) => typeof item === 'string') ||
    typeof data.message_id !== 'string' ||
    data.message_id.length > 500 ||
    (attachments !== undefined &&
      (!Array.isArray(attachments) || !attachments.every(validAttachment)))
  )
    throw new BadRequestException('Resend received-email event is invalid');
  return value as unknown as ResendReceivedEvent;
}

function semanticEventHash(event: ResendReceivedEvent): string {
  const attachments = [...(event.data.attachments ?? [])].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return createHash('sha256')
    .update(
      semanticStringify({
        type: event.type,
        emailId: event.data.email_id,
        from: event.data.from,
        to: [...event.data.to].sort(),
        bcc: [...(event.data.bcc ?? [])].sort(),
        cc: [...(event.data.cc ?? [])].sort(),
        messageId: event.data.message_id,
        subject: event.data.subject ?? null,
        attachments,
      }),
    )
    .digest('hex');
}

function semanticStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(semanticStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${semanticStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function receivedEmailMatches(
  event: ResendReceivedEvent,
  received: ResendReceivedEmail,
  inboxAddress: string,
): boolean {
  if (
    received.id !== event.data.email_id ||
    received.message_id !== event.data.message_id ||
    parseMailbox(received.from).address !==
      parseMailbox(event.data.from).address
  )
    return false;
  return received.to.some(
    (recipient) => parseMailbox(recipient).address === inboxAddress,
  );
}

function parseMailbox(value: string): { address: string; domain: string } {
  const match = value.match(/<([^<>]+)>\s*$/);
  const address = normalizeEmail(match?.[1] ?? value, 'email address');
  return { address, domain: address.slice(address.lastIndexOf('@') + 1) };
}

function normalizeEmail(value: string | undefined, name: string): string {
  const normalized = value?.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  )
    throw new BadRequestException(`${name} must be a valid email address`);
  return normalized;
}

function headerValue(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry?.[1] ?? null;
}

function inboxContext(inbox: InboxRow, requestId: string): TenantContext {
  return {
    organizationId: inbox.organization_id,
    userId: inbox.user_id,
    membershipId: inbox.membership_id,
    role: inbox.role,
    agentId: inbox.agent_id,
    requestId,
  };
}

function requireManager(context: TenantContext): void {
  if (context.role !== 'OWNER' && context.role !== 'ADMIN')
    throw new ForbiddenException(
      'Only owners and admins can manage email inboxes',
    );
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) throw new Error(`Expected ${name} row`);
  return row;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validAttachment(value: unknown): value is ResendAttachment {
  return (
    plainObject(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 100 &&
    (value.filename === undefined ||
      value.filename === null ||
      typeof value.filename === 'string') &&
    (value.content_type === undefined ||
      typeof value.content_type === 'string') &&
    (value.content_disposition === undefined ||
      value.content_disposition === null ||
      typeof value.content_disposition === 'string')
  );
}

function validateReceivedEmail(value: ResendReceivedEmail): void {
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.from !== 'string' ||
    !Array.isArray(value.to) ||
    !value.to.every((item) => typeof item === 'string') ||
    typeof value.message_id !== 'string' ||
    !Array.isArray(value.attachments ?? []) ||
    !(value.attachments ?? []).every(validAttachment)
  )
    throw new ServiceUnavailableException('Resend returned an invalid email');
}

function validateRetrievedAttachment(value: RetrievedAttachment): void {
  if (
    !validAttachment(value) ||
    typeof value.download_url !== 'string' ||
    typeof value.expires_at !== 'string'
  )
    throw new ServiceUnavailableException(
      'Resend returned an invalid attachment',
    );
}
