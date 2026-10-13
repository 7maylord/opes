import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { MembershipRole, TenantContext } from './tenant-context';

export interface UserOrganization {
  id: string;
  slug: string;
  displayName: string;
  lifecycleStatus: string;
  membershipId: string;
  role: string;
  agentId: string;
  agentLifecycleStatus: string;
}

export interface OrganizationMember {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: Date;
}

export interface InviteOrganizationMemberRequest {
  email: string;
  displayName?: string;
  role: MembershipRole;
}

export interface InvitedOrganizationMember extends OrganizationMember {
  invitationToken: string;
}

export interface UpdateOrganizationMemberRequest {
  role?: MembershipRole;
  status?: 'REVOKED';
}

export interface AcceptOrganizationInvitationResult {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
  organization: {
    id: string;
    slug: string;
    displayName: string;
    lifecycleStatus: string;
  };
  membership: OrganizationMember;
}

interface UserOrganizationRow {
  id: string;
  slug: string;
  display_name: string;
  lifecycle_status: string;
  membership_id: string;
  role: string;
  agent_id: string;
  agent_lifecycle_status: string;
}

interface OrganizationMemberRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  created_at: Date;
}

interface MemberUserRow {
  id: string;
  email: string;
  display_name: string;
}

interface InvitationLookupRow {
  id: string;
  organization_id: string;
  membership_id: string;
}

interface AcceptedInvitationRow extends OrganizationMemberRow {
  organization_id: string;
  organization_slug: string;
  organization_display_name: string;
  organization_lifecycle_status: string;
}

interface IdempotencyRecordRow {
  request_hash: string;
  status: string;
  response_payload: unknown;
}

@Injectable()
export class OrganizationService {
  constructor(private readonly database: DatabaseService) {}

  async listForUser(userId: string): Promise<UserOrganization[]> {
    if (userId.trim() === '') {
      throw new Error('userId is required');
    }

    const result = await this.database.withUserScope(userId, (database) =>
      database.query<UserOrganizationRow>(
        `
          SELECT
            organization.id,
            organization.slug,
            organization.display_name,
            organization.lifecycle_status,
            membership.id AS membership_id,
            membership.role,
            agent.id AS agent_id,
            agent.lifecycle_status AS agent_lifecycle_status
          FROM opes.organization_memberships AS membership
          JOIN opes.organizations AS organization
            ON organization.id = membership.organization_id
          JOIN opes.business_agents AS agent
            ON agent.organization_id = organization.id
           AND agent.is_primary = true
          WHERE membership.user_id = $1
            AND membership.status = 'ACTIVE'
          ORDER BY organization.created_at ASC
        `,
        [userId],
      ),
    );

    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      lifecycleStatus: row.lifecycle_status,
      membershipId: row.membership_id,
      role: row.role,
      agentId: row.agent_id,
      agentLifecycleStatus: row.agent_lifecycle_status,
    }));
  }

  async getForTenant(context: TenantContext): Promise<UserOrganization> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<UserOrganizationRow>(
        `
          SELECT
            organization.id,
            organization.slug,
            organization.display_name,
            organization.lifecycle_status,
            membership.id AS membership_id,
            membership.role,
            agent.id AS agent_id,
            agent.lifecycle_status AS agent_lifecycle_status
          FROM opes.organizations AS organization
          JOIN opes.organization_memberships AS membership
            ON membership.organization_id = organization.id
           AND membership.id = $2
          JOIN opes.business_agents AS agent
            ON agent.organization_id = organization.id
           AND agent.is_primary = true
          WHERE organization.id = $1
        `,
        [context.organizationId, context.membershipId],
      ),
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Organization not found');
    }

    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      lifecycleStatus: row.lifecycle_status,
      membershipId: row.membership_id,
      role: row.role,
      agentId: row.agent_id,
      agentLifecycleStatus: row.agent_lifecycle_status,
    };
  }

  async listMembers(context: TenantContext): Promise<OrganizationMember[]> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<OrganizationMemberRow>(
        `
          SELECT
            membership.id,
            membership.user_id,
            app_user.email,
            app_user.display_name,
            membership.role,
            membership.status,
            membership.created_at
          FROM opes.organization_memberships AS membership
          JOIN opes.app_users AS app_user
            ON app_user.id = membership.user_id
          WHERE membership.organization_id = $1
          ORDER BY membership.created_at ASC
        `,
        [context.organizationId],
      ),
    );

    return result.rows.map(mapMember);
  }

  async inviteMember(
    context: TenantContext,
    input: InviteOrganizationMemberRequest,
    idempotencyKey?: string,
  ): Promise<InvitedOrganizationMember> {
    if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
      throw new ForbiddenException('Only owners and admins can invite members');
    }

    const email = normalizeEmail(input.email);
    const role = validateInvitedRole(input.role);
    const displayName = input.displayName?.trim() || email.split('@')[0];
    const invitationToken = createToken();

    return this.withTenantIdempotency(
      context,
      idempotencyKey,
      { action: 'organization.member.invite', input },
      async (database) => {
        const user = await findOrCreateMemberUser(database, email, displayName);

        const existing = await database.query<OrganizationMemberRow>(
          `
          SELECT
            membership.id,
            membership.user_id,
            app_user.email,
            app_user.display_name,
            membership.role,
            membership.status,
            membership.created_at
          FROM opes.organization_memberships AS membership
          JOIN opes.app_users AS app_user
            ON app_user.id = membership.user_id
          WHERE membership.organization_id = $1
            AND membership.user_id = $2
        `,
          [context.organizationId, user.id],
        );

        const existingMember = existing.rows[0];
        if (
          existingMember !== undefined &&
          existingMember.status !== 'REVOKED'
        ) {
          throw new ConflictException(
            'User already has an organization membership',
          );
        }

        const invited =
          existingMember === undefined
            ? await database.query<OrganizationMemberRow>(
                `
                INSERT INTO opes.organization_memberships (
                  organization_id,
                  user_id,
                  role,
                  status,
                  invited_by_membership_id
                )
                VALUES ($1, $2, $3, 'INVITED', $4)
                RETURNING
                  id,
                  user_id,
                  $5::text AS email,
                  $6::text AS display_name,
                  role,
                  status,
                  created_at
              `,
                [
                  context.organizationId,
                  user.id,
                  role,
                  context.membershipId,
                  user.email,
                  user.display_name,
                ],
              )
            : await database.query<OrganizationMemberRow>(
                `
                UPDATE opes.organization_memberships
                   SET role = $3,
                       status = 'INVITED',
                       invited_by_membership_id = $4,
                       updated_at = now()
                 WHERE organization_id = $1
                   AND user_id = $2
                RETURNING
                  id,
                  user_id,
                  $5::text AS email,
                  $6::text AS display_name,
                  role,
                  status,
                  created_at
              `,
                [
                  context.organizationId,
                  user.id,
                  role,
                  context.membershipId,
                  user.email,
                  user.display_name,
                ],
              );

        const member = requireMember(invited.rows[0]);
        await database.query(
          `
          UPDATE opes.organization_invitations
             SET status = 'REVOKED',
                 updated_at = now()
           WHERE organization_id = $1
             AND membership_id = $2
             AND status = 'PENDING'
        `,
          [context.organizationId, member.id],
        );
        await database.query(
          `
          INSERT INTO opes.organization_invitations (
            organization_id,
            membership_id,
            invited_by_membership_id,
            token_hash,
            role,
            status,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, 'PENDING', now() + interval '7 days')
        `,
          [
            context.organizationId,
            member.id,
            context.membershipId,
            hashToken(invitationToken),
            member.role,
          ],
        );
        await database.query(
          `
          INSERT INTO opes.audit_events (
            organization_id,
            actor_user_id,
            actor_membership_id,
            event_type,
            subject_type,
            subject_id,
            payload
          )
          VALUES ($1, $2, $3, 'organization.member.invited', 'organization_membership', $4, $5::jsonb)
        `,
          [
            context.organizationId,
            context.userId,
            context.membershipId,
            member.id,
            JSON.stringify({ email: member.email, role: member.role }),
          ],
        );

        return member;
      },
      (member) => ({
        ...mapMember(member),
        invitationToken,
      }),
      reviveInvitedMember,
    );
  }

  async updateMember(
    context: TenantContext,
    membershipId: string,
    input: UpdateOrganizationMemberRequest,
    idempotencyKey?: string,
  ): Promise<OrganizationMember> {
    if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
      throw new ForbiddenException('Only owners and admins can manage members');
    }

    const targetMembershipId = requireText(membershipId, 'membershipId');
    if (targetMembershipId === context.membershipId) {
      throw new BadRequestException('Cannot update your own membership');
    }

    const nextRole =
      input.role === undefined ? undefined : validateInvitedRole(input.role);
    const nextStatus = validateUpdatedStatus(input.status);
    if (nextRole === undefined && nextStatus === undefined) {
      throw new BadRequestException('role or status is required');
    }

    return this.withTenantIdempotency(
      context,
      idempotencyKey,
      {
        action: 'organization.member.update',
        membershipId: targetMembershipId,
        input,
      },
      async (database) => {
        const existing = await database.query<OrganizationMemberRow>(
          `
          SELECT
            membership.id,
            membership.user_id,
            app_user.email,
            app_user.display_name,
            membership.role,
            membership.status,
            membership.created_at
          FROM opes.organization_memberships AS membership
          JOIN opes.app_users AS app_user
            ON app_user.id = membership.user_id
          WHERE membership.organization_id = $1
            AND membership.id = $2
        `,
          [context.organizationId, targetMembershipId],
        );

        const existingMember = existing.rows[0];
        if (existingMember === undefined) {
          throw new NotFoundException('Organization member not found');
        }
        if (existingMember.role === 'OWNER') {
          throw new ForbiddenException(
            'Owner membership cannot be changed here',
          );
        }

        const updated = await database.query<OrganizationMemberRow>(
          `
          UPDATE opes.organization_memberships AS membership
             SET role = COALESCE($3, membership.role),
                 status = COALESCE($4, membership.status),
                 updated_at = now()
            FROM opes.app_users AS app_user
           WHERE membership.organization_id = $1
             AND membership.id = $2
             AND app_user.id = membership.user_id
          RETURNING
            membership.id,
            membership.user_id,
            app_user.email,
            app_user.display_name,
            membership.role,
            membership.status,
            membership.created_at
        `,
          [context.organizationId, targetMembershipId, nextRole, nextStatus],
        );

        const member = requireMember(updated.rows[0]);
        await database.query(
          `
          INSERT INTO opes.audit_events (
            organization_id,
            actor_user_id,
            actor_membership_id,
            event_type,
            subject_type,
            subject_id,
            payload
          )
          VALUES ($1, $2, $3, 'organization.member.updated', 'organization_membership', $4, $5::jsonb)
        `,
          [
            context.organizationId,
            context.userId,
            context.membershipId,
            member.id,
            JSON.stringify({ role: member.role, status: member.status }),
          ],
        );

        return member;
      },
      mapMember,
      reviveMember,
    );
  }

  async acceptInvitation(
    token: string,
    authenticatedUserId: string,
  ): Promise<AcceptOrganizationInvitationResult> {
    const invitationToken = requireText(token, 'token');

    return this.database.withTransaction(async (database) => {
      const invitationResult = await database.query<InvitationLookupRow>(
        `
          SELECT id, organization_id, membership_id
            FROM opes.organization_invitations
           WHERE token_hash = $1
             AND status = 'PENDING'
             AND expires_at > now()
           LIMIT 1
           FOR UPDATE
        `,
        [hashToken(invitationToken)],
      );

      const invitation = invitationResult.rows[0];
      if (invitation === undefined) {
        throw new NotFoundException('Organization invitation not found');
      }

      await database.query(
        `SELECT set_config('opes.organization_id', $1, true)`,
        [invitation.organization_id],
      );

      const memberResult = await database.query<AcceptedInvitationRow>(
        `
          UPDATE opes.organization_memberships AS membership
             SET status = 'ACTIVE',
                 updated_at = now()
            FROM opes.app_users AS app_user,
                 opes.organizations AS organization
           WHERE membership.organization_id = $1
             AND membership.id = $2
             AND membership.status = 'INVITED'
             AND membership.user_id = $3
             AND app_user.id = membership.user_id
             AND organization.id = membership.organization_id
          RETURNING
            membership.id,
            membership.user_id,
            app_user.email,
            app_user.display_name,
            membership.role,
            membership.status,
            membership.created_at,
            organization.id AS organization_id,
            organization.slug AS organization_slug,
            organization.display_name AS organization_display_name,
            organization.lifecycle_status AS organization_lifecycle_status
        `,
        [
          invitation.organization_id,
          invitation.membership_id,
          authenticatedUserId,
        ],
      );

      if (memberResult.rows[0] === undefined) {
        throw new ForbiddenException('Invitation does not belong to this user');
      }
      const member = memberResult.rows[0];
      await database.query(
        `
          UPDATE opes.organization_invitations
             SET status = 'ACCEPTED',
                 accepted_at = now(),
                 updated_at = now()
           WHERE id = $1
        `,
        [invitation.id],
      );
      await database.query(
        `
          INSERT INTO opes.audit_events (
            organization_id,
            actor_user_id,
            actor_membership_id,
            event_type,
            subject_type,
            subject_id,
            payload
          )
          VALUES ($1, $2, $3, 'organization.invitation.accepted', 'organization_membership', $3, '{}'::jsonb)
        `,
        [invitation.organization_id, member.user_id, member.id],
      );

      return {
        user: {
          id: member.user_id,
          email: member.email,
          displayName: member.display_name,
        },
        organization: {
          id: member.organization_id,
          slug: member.organization_slug,
          displayName: member.organization_display_name,
          lifecycleStatus: member.organization_lifecycle_status,
        },
        membership: mapMember(member),
      };
    });
  }

  private async withTenantIdempotency<T>(
    context: TenantContext,
    key: string | undefined,
    request: unknown,
    work: (database: TenantDatabase) => Promise<OrganizationMemberRow>,
    mapResult: (row: OrganizationMemberRow) => T,
    revive: (payload: unknown) => T,
  ): Promise<T> {
    const idempotencyKey = key?.trim();
    if (idempotencyKey === undefined || idempotencyKey === '') {
      const row = await this.database.withTenant(context, work);
      return mapResult(row);
    }

    if (idempotencyKey.length > 200) {
      throw new BadRequestException('idempotency key is too long');
    }

    const requestHash = hashJson(request);
    return this.database.withTenant(context, async (database) => {
      const inserted = await database.query(
        `
          INSERT INTO opes.idempotency_records (
            organization_id,
            idempotency_key,
            request_hash
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (organization_id, idempotency_key) DO NOTHING
        `,
        [context.organizationId, idempotencyKey, requestHash],
      );

      if (inserted.rowCount === 0) {
        const existing = await database.query<IdempotencyRecordRow>(
          `
            SELECT request_hash, status, response_payload
              FROM opes.idempotency_records
             WHERE organization_id = $1
               AND idempotency_key = $2
          `,
          [context.organizationId, idempotencyKey],
        );
        const record = existing.rows[0];
        if (record?.request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency key was used with a different request',
          );
        }
        if (record.status !== 'COMPLETED') {
          throw new ConflictException(
            'Idempotency request is still processing',
          );
        }

        return revive(record.response_payload);
      }

      const row = await work(database);
      const response = mapResult(row);
      await database.query(
        `
          UPDATE opes.idempotency_records
             SET status = 'COMPLETED',
                 response_payload = $3::jsonb,
                 updated_at = now()
           WHERE organization_id = $1
             AND idempotency_key = $2
        `,
        [context.organizationId, idempotencyKey, JSON.stringify(response)],
      );

      return response;
    });
  }
}

async function findOrCreateMemberUser(
  database: { query: TenantDatabase['query'] },
  email: string,
  displayName: string,
): Promise<MemberUserRow> {
  const existing = await database.query<MemberUserRow>(
    `
      SELECT id, email, display_name
        FROM opes.app_users
       WHERE email_normalized = lower($1)
    `,
    [email],
  );

  if (existing.rows[0] !== undefined) {
    return existing.rows[0];
  }

  const inserted = await database.query<MemberUserRow>(
    `
      INSERT INTO opes.app_users (email, display_name)
      VALUES ($1, $2)
      RETURNING id, email, display_name
    `,
    [email, displayName],
  );

  const user = inserted.rows[0];
  if (user === undefined) {
    throw new Error('Expected user row');
  }

  return user;
}

function mapMember(row: OrganizationMemberRow): OrganizationMember {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

function reviveMember(payload: unknown): OrganizationMember {
  const member = payload as OrganizationMember & { createdAt: string | Date };
  return {
    ...member,
    createdAt: new Date(member.createdAt),
  };
}

function reviveInvitedMember(payload: unknown): InvitedOrganizationMember {
  const member = payload as InvitedOrganizationMember & {
    createdAt: string | Date;
  };
  return {
    ...member,
    createdAt: new Date(member.createdAt),
  };
}

function normalizeEmail(value: string): string {
  const email = requireText(value, 'email').toLowerCase();
  if (email === '' || !email.includes('@')) {
    throw new BadRequestException('email must be valid');
  }

  return email;
}

function validateInvitedRole(role: MembershipRole): MembershipRole {
  if (
    role !== 'ADMIN' &&
    role !== 'APPROVER' &&
    role !== 'OPERATOR_VIEWER' &&
    role !== 'AUDITOR'
  ) {
    throw new BadRequestException('role cannot be invited');
  }

  return role;
}

function validateUpdatedStatus(
  status: UpdateOrganizationMemberRequest['status'],
): UpdateOrganizationMemberRequest['status'] {
  if (status === undefined || status === 'REVOKED') {
    return status;
  }

  throw new BadRequestException('status cannot be updated');
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text === '') {
    throw new BadRequestException(`${name} is required`);
  }

  return text;
}

function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireMember<T extends OrganizationMemberRow>(row: T | undefined): T {
  if (row === undefined) {
    throw new Error('Expected membership row');
  }

  return row;
}
