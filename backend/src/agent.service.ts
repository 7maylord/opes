import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TenantContext } from './tenant-context';

export interface AgentResourceBinding {
  id: string;
  environment: string;
  chainId: number | null;
  provider: string;
  resourceType: string;
  resourceId: string;
  address: string | null;
  status: string;
  metadata: unknown;
}

export interface BusinessAgentDetail {
  id: string;
  lifecycleStatus: string;
  resourceBindings: AgentResourceBinding[];
}

interface AgentRow {
  id: string;
  lifecycle_status: string;
}

interface BindingRow {
  id: string;
  environment: string;
  chain_id: number | null;
  provider: string;
  resource_type: string;
  resource_id: string;
  address: string | null;
  status: string;
  metadata: unknown;
}

@Injectable()
export class AgentService {
  constructor(private readonly database: DatabaseService) {}

  async getPrimaryAgent(context: TenantContext): Promise<BusinessAgentDetail> {
    return this.database.withTenant(context, async (database) => {
      const agentResult = await database.query<AgentRow>(
        `
          SELECT id, lifecycle_status
            FROM opes.business_agents
           WHERE organization_id = $1
             AND id = $2
             AND is_primary = true
        `,
        [context.organizationId, context.agentId],
      );

      const agent = agentResult.rows[0];
      if (agent === undefined) {
        throw new NotFoundException('Business agent not found');
      }

      const bindings = await database.query<BindingRow>(
        `
          SELECT
            id,
            environment,
            chain_id,
            provider,
            resource_type,
            resource_id,
            address,
            status,
            metadata
          FROM opes.tenant_resource_bindings
          WHERE organization_id = $1
          ORDER BY created_at ASC
        `,
        [context.organizationId],
      );

      return {
        id: agent.id,
        lifecycleStatus: agent.lifecycle_status,
        resourceBindings: bindings.rows.map((row) => ({
          id: row.id,
          environment: row.environment,
          chainId: row.chain_id,
          provider: row.provider,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          address: row.address,
          status: row.status,
          metadata: row.metadata,
        })),
      };
    });
  }
}
