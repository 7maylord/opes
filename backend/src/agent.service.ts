import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import {
  FactoryManifestService,
  VerifiedFactoryManifest,
} from './factory-manifest.service';
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
  arcTestnetFactory: VerifiedFactoryManifest;
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
  constructor(
    private readonly database: DatabaseService,
    private readonly factoryManifests: FactoryManifestService,
  ) {}

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
        arcTestnetFactory: this.factoryManifests.getArcTestnetFactory(),
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

  async requestArcTestnetProvisioning(
    context: TenantContext,
  ): Promise<AgentResourceBinding> {
    const factory = this.factoryManifests.getArcTestnetFactory();
    if (factory.verification !== 'fully_verified') {
      throw new Error('Arc testnet factory is not verified');
    }

    return this.database.withTenant(context, async (database) => {
      const existing = await database.query<BindingRow>(
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
            AND provider = 'arc'
            AND environment = $2
            AND resource_type = 'factory_provisioning'
            AND resource_id = $3
          LIMIT 1
        `,
        [context.organizationId, factory.environment, context.organizationId],
      );

      if (existing.rows[0] !== undefined) {
        await enqueueProvisioningEvent(
          database,
          context.organizationId,
          existing.rows[0].id,
        );
        return mapBinding(existing.rows[0]);
      }

      const inserted = await database.query<BindingRow>(
        `
          INSERT INTO opes.tenant_resource_bindings (
            organization_id,
            environment,
            chain_id,
            provider,
            resource_type,
            resource_id,
            status,
            metadata
          )
          VALUES ($1, $2, $3, 'arc', 'factory_provisioning', $4, 'PENDING', $5::jsonb)
          RETURNING
            id,
            environment,
            chain_id,
            provider,
            resource_type,
            resource_id,
            address,
            status,
            metadata
        `,
        [
          context.organizationId,
          factory.environment,
          factory.chainId,
          context.organizationId,
          JSON.stringify({
            factoryAddress: factory.factoryAddress,
            vaultDeployerAddress: factory.vaultDeployerAddress,
            verification: factory.verification,
            checkedAt: factory.checkedAt,
          }),
        ],
      );

      const binding = requireBinding(inserted.rows[0]);
      await enqueueProvisioningEvent(
        database,
        context.organizationId,
        binding.id,
      );

      return mapBinding(binding);
    });
  }
}

async function enqueueProvisioningEvent(
  database: TenantDatabase,
  organizationId: string,
  bindingId: string,
): Promise<void> {
  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      SELECT $1, 'agent.provision.arc_testnet', 'tenant_resource_binding', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = 'agent.provision.arc_testnet'
           AND aggregate_type = 'tenant_resource_binding'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, bindingId],
  );
}

function mapBinding(row: BindingRow): AgentResourceBinding {
  return {
    id: row.id,
    environment: row.environment,
    chainId: row.chain_id,
    provider: row.provider,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    address: row.address,
    status: row.status,
    metadata: row.metadata,
  };
}

function requireBinding(row: BindingRow | undefined): BindingRow {
  if (row === undefined) {
    throw new Error('Expected resource binding row');
  }

  return row;
}
