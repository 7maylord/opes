import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { FactoryManifestService } from './factory-manifest.service';
import { organizationDomain } from './evm-decision-hash';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
  event_type: string;
}

export interface ArcProvisioningSuccess {
  organizationId: string;
  provisioningBindingId: string;
  vaultAddress: string;
  escrowAddress: string;
  transactionHash: string;
  blockNumber: number;
  sourceVerification: 'fully_verified' | 'unverified';
}

@Injectable()
export class ProvisioningWorkerService {
  private readonly logger = new Logger(ProvisioningWorkerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly factoryManifests: FactoryManifestService,
  ) {}

  async recordArcProvisioningSuccess(
    result: ArcProvisioningSuccess,
  ): Promise<void> {
    const factory = this.factoryManifests.getArcTestnetFactory();
    if (factory.verification !== 'fully_verified') {
      throw new Error('Arc testnet factory is not verified');
    }
    if (result.sourceVerification !== 'fully_verified') {
      throw new Error('Arc tenant contracts are not verified');
    }

    assertHexAddress('vaultAddress', result.vaultAddress);
    assertHexAddress('escrowAddress', result.escrowAddress);
    assertTransactionHash(result.transactionHash);

    await this.database.withWorker(async (database) => {
      await activateFactoryProvisioningBinding(database, result);
      await upsertContractBinding(
        database,
        result,
        'business_policy_vault_contract',
        result.vaultAddress,
      );
      await upsertContractBinding(
        database,
        result,
        'milestone_escrow_contract',
        result.escrowAddress,
      );
      await markPrimaryAgentSetupRequired(database, result.organizationId);
    });
  }

  async processDueArcProvisioning(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextArcProvisioningEvent();
      if (event === undefined) {
        return processed;
      }

      await this.failUnconfiguredArcProvisioning(event);
      processed += 1;
    }

    return processed;
  }

  private async claimNextArcProvisioningEvent(): Promise<
    OutboxEventRow | undefined
  > {
    return this.database.withWorker(async (database) => {
      const result = await database.query<OutboxEventRow>(
        `
          UPDATE opes.outbox_events
             SET status = 'PROCESSING',
                 updated_at = now()
           WHERE id = (
             SELECT id
               FROM opes.outbox_events
              WHERE event_type IN ('agent.provision.arc_testnet', 'agent.wallet.provision.arc_testnet')
                AND (
                      (status = 'PENDING' AND available_at <= now())
                   OR (status = 'PROCESSING' AND updated_at < now() - interval '5 minutes')
                    )
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           RETURNING id, organization_id, aggregate_id, event_type
        `,
      );

      return result.rows[0];
    });
  }

  private async failUnconfiguredArcProvisioning(
    event: OutboxEventRow,
  ): Promise<void> {
    const reason = provisioningFailureReason(event.event_type);

    await this.database.withWorker(async (database) => {
      await updateFailedProvisioningBinding(database, event, reason);
      await failOutboxEvent(database, event.id, reason);
    });

    this.logger.warn(`arc provisioning job ${event.id} failed: ${reason}`);
  }
}

async function updateFailedProvisioningBinding(
  database: TenantDatabase,
  event: OutboxEventRow,
  reason: string,
): Promise<void> {
  const expected = expectedProvisioningBinding(event.event_type);

  await database.query(
    `
      UPDATE opes.tenant_resource_bindings
         SET status = 'FAILED',
             metadata = metadata || jsonb_build_object(
               'failureReason', $5::text,
               'failedAt', now()
             ),
             updated_at = now()
       WHERE organization_id = $1
         AND id = $2
         AND provider = $3
         AND environment = 'arc-testnet'
         AND resource_type = $4
         AND status IN ('PENDING', 'FAILED')
    `,
    [
      event.organization_id,
      event.aggregate_id,
      expected.provider,
      expected.resourceType,
      reason,
    ],
  );
}

function provisioningFailureReason(eventType: string): string {
  if (eventType === 'agent.wallet.provision.arc_testnet') {
    return 'Arc wallet provider is not configured';
  }

  return 'Arc provisioning provider is not configured';
}

function expectedProvisioningBinding(eventType: string): {
  provider: string;
  resourceType: string;
} {
  if (eventType === 'agent.wallet.provision.arc_testnet') {
    return { provider: 'circle', resourceType: 'operator_wallet' };
  }

  return { provider: 'arc', resourceType: 'factory_provisioning' };
}

async function failOutboxEvent(
  database: TenantDatabase,
  eventId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.outbox_events
         SET status = 'FAILED',
             payload = payload || jsonb_build_object('failureReason', $2::text),
             processed_at = now(),
             updated_at = now()
       WHERE id = $1
    `,
    [eventId, reason],
  );
}

async function activateFactoryProvisioningBinding(
  database: TenantDatabase,
  result: ArcProvisioningSuccess,
): Promise<void> {
  const updated = await database.query(
    `
      UPDATE opes.tenant_resource_bindings
         SET status = 'ACTIVE',
             metadata = metadata || jsonb_build_object(
               'vaultAddress', $3::text,
               'escrowAddress', $4::text,
               'transactionHash', $5::text,
               'blockNumber', $6::integer,
               'sourceVerification', $7::text,
               'organizationDomain', $8::text,
               'activatedAt', now()
             ),
             updated_at = now()
       WHERE organization_id = $1
         AND id = $2
         AND provider = 'arc'
         AND environment = 'arc-testnet'
         AND resource_type = 'factory_provisioning'
         AND status IN ('PENDING', 'FAILED', 'ACTIVE')
       RETURNING id
    `,
    [
      result.organizationId,
      result.provisioningBindingId,
      result.vaultAddress,
      result.escrowAddress,
      result.transactionHash,
      result.blockNumber,
      result.sourceVerification,
      organizationDomain(result.organizationId, 'arc-testnet'),
    ],
  );

  if (updated.rows[0] === undefined) {
    throw new Error('Arc factory provisioning binding not found');
  }
}

async function upsertContractBinding(
  database: TenantDatabase,
  result: ArcProvisioningSuccess,
  resourceType: string,
  address: string,
): Promise<void> {
  const upserted = await database.query(
    `
      INSERT INTO opes.tenant_resource_bindings (
        organization_id,
        environment,
        chain_id,
        provider,
        resource_type,
        resource_id,
        address,
        status,
        metadata
      )
      VALUES (
        $1,
        'arc-testnet',
        5042002,
        'arc',
        $2,
        $1,
        $3,
        'ACTIVE',
        jsonb_build_object(
          'provisioningBindingId', $4::uuid,
          'transactionHash', $5::text,
          'blockNumber', $6::integer,
          'sourceVerification', $7::text,
          'organizationDomain', $8::text
        )
      )
      ON CONFLICT (provider, environment, resource_type, resource_id)
      DO UPDATE
            SET address = EXCLUDED.address,
                status = 'ACTIVE',
                metadata = opes.tenant_resource_bindings.metadata || EXCLUDED.metadata,
                updated_at = now()
          WHERE opes.tenant_resource_bindings.organization_id = EXCLUDED.organization_id
            AND (
              opes.tenant_resource_bindings.address IS NULL
              OR lower(opes.tenant_resource_bindings.address) = lower(EXCLUDED.address)
            )
      RETURNING id
    `,
    [
      result.organizationId,
      resourceType,
      address,
      result.provisioningBindingId,
      result.transactionHash,
      result.blockNumber,
      result.sourceVerification,
      organizationDomain(result.organizationId, 'arc-testnet'),
    ],
  );

  if (upserted.rows[0] === undefined) {
    throw new Error(`Conflicting Arc ${resourceType} binding`);
  }
}

async function markPrimaryAgentSetupRequired(
  database: TenantDatabase,
  organizationId: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.business_agents
         SET lifecycle_status = 'SETUP_REQUIRED',
             updated_at = now()
       WHERE organization_id = $1
         AND is_primary = true
         AND lifecycle_status = 'PROVISIONING'
    `,
    [organizationId],
  );
}

function assertHexAddress(label: string, value: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be an EVM address`);
  }
}

function assertTransactionHash(value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('transactionHash must be an EVM transaction hash');
  }
}
