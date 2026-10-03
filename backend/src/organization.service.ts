import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TenantContext } from './tenant-context';

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

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
    }));
  }
}
