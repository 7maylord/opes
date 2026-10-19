import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import {
  DocumentStorageService,
  InitiateDocumentUploadRequest,
  InitiateDocumentUploadResponse,
} from '../evidence/document-storage.service';
import { TenantContext } from '../../core/database/tenant-context';

interface AccessRow {
  id: string;
  organization_id: string;
  vendor_id: string;
  contact_email: string;
  status: string;
  expires_at: Date;
  vendor_name: string;
  organization_name: string;
  agent_id: string;
}

interface SubmissionRow {
  id: string;
  document_id: string;
  root_submission_id: string | null;
  version: number;
  status: string;
  vendor_note: string | null;
  document_type: string;
  filename: string;
  created_at: Date;
  submitted_at: Date | null;
}

export interface VendorPortalSubmission {
  id: string;
  documentId: string;
  rootSubmissionId: string;
  version: number;
  status: string;
  vendorNote: string | null;
  documentType: string;
  filename: string;
  createdAt: Date;
  submittedAt: Date | null;
}

@Injectable()
export class VendorPortalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DocumentStorageService,
  ) {}

  async createAccess(
    context: TenantContext,
    vendorId: string,
    input: { contactEmail: string; expiresAt: string },
  ) {
    requireManager(context);
    requireUuid(vendorId, 'vendorId');
    const contactEmail = normalizeEmail(input.contactEmail);
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= new Date())
      throw new BadRequestException('expiresAt must be in the future');
    if (expiresAt.valueOf() > Date.now() + 90 * 24 * 60 * 60 * 1000)
      throw new BadRequestException('expiresAt cannot exceed 90 days');
    const token = randomBytes(32).toString('base64url');
    const result = await this.database.withTenant(context, async (database) => {
      const vendor = await database.query(
        `SELECT 1 FROM opes.vendors WHERE organization_id=$1 AND id=$2 AND status<>'DISABLED'`,
        [context.organizationId, vendorId],
      );
      if (!vendor.rows[0]) throw new BadRequestException('Vendor not found');
      return database.query<{ id: string }>(
        `INSERT INTO opes.vendor_portal_accesses
          (organization_id,vendor_id,token_hash,contact_email,expires_at,created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          context.organizationId,
          vendorId,
          hashToken(token),
          contactEmail,
          expiresAt,
          context.membershipId,
        ],
      );
    });
    return { id: result.rows[0].id, vendorId, contactEmail, expiresAt, token };
  }

  async revokeAccess(context: TenantContext, accessId: string) {
    requireManager(context);
    requireUuid(accessId, 'accessId');
    const result = await this.database.withTenant(context, (database) =>
      database.query<{ id: string }>(
        `UPDATE opes.vendor_portal_accesses SET status='REVOKED',revoked_at=now()
         WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id`,
        [context.organizationId, accessId],
      ),
    );
    if (!result.rows[0])
      throw new ConflictException('Vendor access is not active');
    return { id: accessId, status: 'REVOKED' };
  }

  async getPortal(token: string) {
    const access = await this.resolveAccess(token);
    return {
      organizationName: access.organization_name,
      vendorName: access.vendor_name,
      contactEmail: access.contact_email,
      expiresAt: access.expires_at,
    };
  }

  async initiateSubmission(
    token: string,
    idempotencyKey: string | undefined,
    input: InitiateDocumentUploadRequest & {
      vendorNote?: string;
      replacesSubmissionId?: string;
    },
  ): Promise<{
    submission: VendorPortalSubmission;
    upload: InitiateDocumentUploadResponse;
  }> {
    const access = await this.resolveAccess(token);
    const key = requireIdempotencyKey(idempotencyKey);
    const context = portalContext(access, key);
    const note = input.vendorNote?.trim().slice(0, 2000) || null;
    const upload = await this.documents.initiateUpload(
      context,
      {
        ...input,
        sourceEventId: `${access.id}:${key}`,
        metadata: {
          vendorPortal: {
            vendorId: access.vendor_id,
            accessId: access.id,
            vendorNote: note,
            trustedForVendorOrPayoutAuthority: false,
          },
        },
      },
      { sourceType: 'VENDOR_PORTAL', automated: true },
    );
    const submission = await this.database.withOrganizationScope(
      access.organization_id,
      (database) =>
        this.recordSubmission(
          database,
          access,
          upload.document.id,
          note,
          input.replacesSubmissionId,
        ),
    );
    return { submission, upload };
  }

  async finalizeSubmission(token: string, submissionId: string) {
    const access = await this.resolveAccess(token);
    requireUuid(submissionId, 'submissionId');
    const context = portalContext(access, submissionId);
    const found = await this.database.withOrganizationScope(
      access.organization_id,
      (database) =>
        database.query<{ document_id: string; status: string }>(
          `SELECT document_id,status FROM opes.vendor_portal_submissions
         WHERE organization_id=$1 AND id=$2 AND vendor_id=$3 AND access_id=$4`,
          [access.organization_id, submissionId, access.vendor_id, access.id],
        ),
    );
    const row = found.rows[0];
    if (!row)
      throw new UnauthorizedException('Vendor submission is unavailable');
    if (row.status !== 'UPLOADING')
      return this.getSubmission(access, submissionId);
    await this.documents.finalizeUpload(context, row.document_id);
    await this.database.withOrganizationScope(
      access.organization_id,
      (database) =>
        database.query(
          `UPDATE opes.vendor_portal_submissions SET status='SUBMITTED',submitted_at=now()
         WHERE organization_id=$1 AND id=$2 AND status='UPLOADING'`,
          [access.organization_id, submissionId],
        ),
    );
    return this.getSubmission(access, submissionId);
  }

  async listSubmissions(token: string) {
    const access = await this.resolveAccess(token);
    const result = await this.database.withOrganizationScope(
      access.organization_id,
      (database) =>
        selectSubmissions(database, access.organization_id, access.vendor_id),
    );
    return result.rows.map(mapSubmission);
  }

  private async resolveAccess(token: string): Promise<AccessRow> {
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(token))
      throw new UnauthorizedException('Vendor access is invalid or expired');
    const lookup = await this.database.withWorker((database) =>
      database.query<
        Pick<
          AccessRow,
          | 'id'
          | 'organization_id'
          | 'vendor_id'
          | 'contact_email'
          | 'status'
          | 'expires_at'
        >
      >(
        `SELECT id,organization_id,vendor_id,contact_email,status,expires_at
         FROM opes.vendor_portal_accesses WHERE token_hash=$1`,
        [hashToken(token)],
      ),
    );
    const found = lookup.rows[0];
    if (!found || found.status !== 'ACTIVE' || found.expires_at <= new Date())
      throw new UnauthorizedException('Vendor access is invalid or expired');
    const result = await this.database.withOrganizationScope(
      found.organization_id,
      (database) =>
        database.query<AccessRow>(
          `SELECT access.id,access.organization_id,access.vendor_id,access.contact_email,
                access.status,access.expires_at,vendor.display_name AS vendor_name,
                organization.display_name AS organization_name,agent.id AS agent_id
         FROM opes.vendor_portal_accesses access
         JOIN opes.vendors vendor ON vendor.organization_id=access.organization_id AND vendor.id=access.vendor_id
         JOIN opes.organizations organization ON organization.id=access.organization_id
         JOIN opes.business_agents agent ON agent.organization_id=access.organization_id AND agent.is_primary=true
         WHERE access.id=$1`,
          [found.id],
        ),
    );
    const access = result.rows[0];
    if (
      !access ||
      access.status !== 'ACTIVE' ||
      access.expires_at <= new Date()
    )
      throw new UnauthorizedException('Vendor access is invalid or expired');
    return access;
  }

  private async recordSubmission(
    database: TenantDatabase,
    access: AccessRow,
    documentId: string,
    note: string | null,
    replacesId?: string,
  ): Promise<VendorPortalSubmission> {
    const replay = await database.query<SubmissionRow>(
      `${submissionSelect} WHERE submission.organization_id=$1 AND submission.document_id=$2`,
      [access.organization_id, documentId],
    );
    if (replay.rows[0]) return mapSubmission(replay.rows[0]);

    let rootId: string | null = null;
    let version = 1;
    if (replacesId) {
      requireUuid(replacesId, 'replacesSubmissionId');
      const previous = await database.query<{
        id: string;
        root_submission_id: string | null;
        version: number;
        status: string;
      }>(
        `SELECT id,root_submission_id,version,status FROM opes.vendor_portal_submissions
         WHERE organization_id=$1 AND id=$2 AND vendor_id=$3 FOR UPDATE`,
        [access.organization_id, replacesId, access.vendor_id],
      );
      const row = previous.rows[0];
      if (!row || row.status !== 'SUBMITTED')
        throw new ConflictException(
          'Only a current submitted version can be corrected',
        );
      rootId = row.root_submission_id ?? row.id;
      const latest = await database.query<{ version: number }>(
        `SELECT version FROM opes.vendor_portal_submissions
         WHERE organization_id=$1 AND (id=$2 OR root_submission_id=$2)
         ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [access.organization_id, rootId],
      );
      if (latest.rows[0]?.version !== row.version)
        throw new ConflictException(
          'Only the latest submission version can be corrected',
        );
      version = row.version + 1;
      await database.query(
        `UPDATE opes.vendor_portal_submissions SET status='SUPERSEDED'
         WHERE organization_id=$1 AND id=$2`,
        [access.organization_id, row.id],
      );
    }
    const inserted = await database.query<SubmissionRow>(
      `${submissionInsert} RETURNING id,document_id,root_submission_id,version,status,vendor_note,
        ''::text AS document_type,''::text AS filename,created_at,submitted_at`,
      [
        access.organization_id,
        access.vendor_id,
        access.id,
        documentId,
        rootId,
        version,
        note,
      ],
    );
    const row = inserted.rows[0];
    const complete = await database.query<SubmissionRow>(
      `${submissionSelect} WHERE submission.organization_id=$1 AND submission.id=$2`,
      [access.organization_id, row.id],
    );
    return mapSubmission(complete.rows[0]);
  }

  private async getSubmission(access: AccessRow, id: string) {
    const result = await this.database.withOrganizationScope(
      access.organization_id,
      (database) =>
        database.query<SubmissionRow>(
          `${submissionSelect} WHERE submission.organization_id=$1 AND submission.id=$2 AND submission.vendor_id=$3`,
          [access.organization_id, id, access.vendor_id],
        ),
    );
    if (!result.rows[0])
      throw new UnauthorizedException('Vendor submission is unavailable');
    return mapSubmission(result.rows[0]);
  }
}

const submissionSelect = `SELECT submission.id,submission.document_id,submission.root_submission_id,
  submission.version,submission.status,submission.vendor_note,document.document_type,document.filename,
  submission.created_at,submission.submitted_at FROM opes.vendor_portal_submissions submission
  JOIN opes.evidence_documents document ON document.organization_id=submission.organization_id AND document.id=submission.document_id`;
const submissionInsert = `INSERT INTO opes.vendor_portal_submissions
  (organization_id,vendor_id,access_id,document_id,root_submission_id,version,vendor_note)
  VALUES ($1,$2,$3,$4,$5,$6,$7)`;

function selectSubmissions(
  database: TenantDatabase,
  organizationId: string,
  vendorId: string,
) {
  return database.query<SubmissionRow>(
    `${submissionSelect} WHERE submission.organization_id=$1 AND submission.vendor_id=$2 ORDER BY submission.created_at`,
    [organizationId, vendorId],
  );
}
function mapSubmission(row: SubmissionRow): VendorPortalSubmission {
  return {
    id: row.id,
    documentId: row.document_id,
    rootSubmissionId: row.root_submission_id ?? row.id,
    version: row.version,
    status: row.status,
    vendorNote: row.vendor_note,
    documentType: row.document_type,
    filename: row.filename,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  };
}
function portalContext(access: AccessRow, requestId: string): TenantContext {
  return {
    organizationId: access.organization_id,
    userId: access.id,
    membershipId: access.id,
    role: 'OPERATOR_VIEWER',
    agentId: access.agent_id,
    requestId,
  };
}
function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
function requireManager(context: TenantContext) {
  if (context.role !== 'OWNER' && context.role !== 'ADMIN')
    throw new ForbiddenException(
      'Only owners and admins can manage vendor access',
    );
}
function requireUuid(value: string, name: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException(`${name} must be a UUID`);
}
function normalizeEmail(value: string) {
  const email = value?.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new BadRequestException('contactEmail must be valid');
  return email;
}
function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(key))
    throw new BadRequestException('Valid Idempotency-Key is required');
  return key;
}
