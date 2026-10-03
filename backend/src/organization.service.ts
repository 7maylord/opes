import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
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

@Injectable()
export class OrganizationService {
  constructor(private readonly database: DatabaseService) {}

  async listForUser(userId: string): Promise<UserOrganization[]> {
    if (userId.trim() === '') {
      throw new Error('userId is required');
    }

    const result = await this.database.withDatabase((database) =>
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
  ): Promise<OrganizationMember> {
    if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
      throw new ForbiddenException('Only owners and admins can invite members');
    }

    const email = normalizeEmail(input.email);
    const role = validateInvitedRole(input.role);
    const displayName = input.displayName?.trim() || email.split('@')[0];

    const result = await this.database.withTenant(context, async (database) => {
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
      if (existingMember !== undefined && existingMember.status !== 'REVOKED') {
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
    });

    return mapMember(result);
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

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
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

function requireMember(
  row: OrganizationMemberRow | undefined,
): OrganizationMemberRow {
  if (row === undefined) {
    throw new Error('Expected membership row');
  }

  return row;
}
