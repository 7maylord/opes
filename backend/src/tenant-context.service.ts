import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { MembershipRole, TenantContext } from './tenant-context';

interface TenantContextRow {
  membership_id: string;
  role: MembershipRole;
  agent_id: string;
}

export interface ResolveTenantContextInput {
  organizationId: string;
  userId: string;
  requestId: string;
}

@Injectable()
export class TenantContextService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(input: ResolveTenantContextInput): Promise<TenantContext> {
    const result = await this.database.withOrganizationScope(
      input.organizationId,
      (database) =>
        database.query<TenantContextRow>(
          `
            SELECT
              membership.id AS membership_id,
              membership.role,
              agent.id AS agent_id
            FROM opes.organization_memberships AS membership
            JOIN opes.business_agents AS agent
              ON agent.organization_id = membership.organization_id
             AND agent.is_primary = true
            WHERE membership.organization_id = $1
              AND membership.user_id = $2
              AND membership.status = 'ACTIVE'
            LIMIT 1
          `,
          [input.organizationId, input.userId],
        ),
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Active organization membership not found');
    }

    return {
      organizationId: input.organizationId,
      userId: input.userId,
      membershipId: row.membership_id,
      role: row.role,
      agentId: row.agent_id,
      requestId: input.requestId,
    };
  }
}
