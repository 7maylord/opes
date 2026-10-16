import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { DatabaseService, TenantDatabase } from './database.service';
import {
  FactoryManifestService,
  VerifiedFactoryManifest,
} from './factory-manifest.service';
import { organizationDomain } from './evm-decision-hash';
import { CircleWalletService } from './circle-wallet.service';
import factoryAbi from './abi/OrganizationFactory.json';
import vaultAbi from './abi/BusinessPolicyVault.json';
import escrowAbi from './abi/MilestoneEscrow.json';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
  event_type: string;
}

type AbiEntry = {
  type: string;
  name?: string;
  inputs?: Array<{ type: string }>;
};

interface RpcReceipt {
  status: string;
  blockNumber: string;
}

async function ensureFactoryProvisioningBinding(
  database: TenantDatabase,
  organizationId: string,
  factory: VerifiedFactoryManifest,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO opes.tenant_resource_bindings (
       organization_id, environment, chain_id, provider,
       resource_type, resource_id, status, metadata
     ) VALUES ($1::uuid, 'arc-testnet', 5042002, 'arc',
               'factory_provisioning', $1::text, 'PENDING', $2::jsonb)
     ON CONFLICT (provider, environment, resource_type, resource_id)
     DO UPDATE SET status = CASE
                       WHEN opes.tenant_resource_bindings.status = 'FAILED' THEN 'PENDING'
                       ELSE opes.tenant_resource_bindings.status END,
                   updated_at = now()
     RETURNING id`,
    [
      organizationId,
      JSON.stringify({
        factoryAddress: factory.factoryAddress,
        vaultDeployerAddress: factory.vaultDeployerAddress,
        verification: factory.verification,
      }),
    ],
  );
  return requireRow(result.rows[0], 'factory provisioning binding').id;
}

async function enqueueFactoryProvisioning(
  database: TenantDatabase,
  organizationId: string,
  bindingId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO opes.outbox_events (
       organization_id, event_type, aggregate_type, aggregate_id, payload
     )
     SELECT $1, 'agent.provision.arc_testnet', 'tenant_resource_binding', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM opes.outbox_events
         WHERE organization_id = $1 AND event_type = 'agent.provision.arc_testnet'
           AND aggregate_id = $2 AND status IN ('PENDING', 'PROCESSING')
      )`,
    [organizationId, bindingId],
  );
}

async function markOutboxProcessed(
  database: TenantDatabase,
  eventId: string,
): Promise<void> {
  await database.query(
    `UPDATE opes.outbox_events
        SET status = 'PROCESSED', payload = payload - 'lastError',
            processed_at = now(), updated_at = now()
      WHERE id = $1`,
    [eventId],
  );
}

function stableUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function textMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown provisioning error';
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new Error(`Expected ${name}`);
  return row;
}

async function readFactoryDeployment(
  factoryAddress: string,
  domain: string,
): Promise<FactoryDeployment | undefined> {
  const result = await ethCall(
    factoryAddress,
    encodeCall(factoryAbi, 'deployments', [domain]),
  );
  const words = decodeWords(result);
  const vaultAddress = wordAddress(words[0]);
  if (vaultAddress === zeroAddress) return undefined;
  return {
    vaultAddress,
    escrowAddress: wordAddress(words[1]),
    configurationHash: `0x${words[2]}`,
  };
}

async function hasFactoryProvisionerRole(
  factoryAddress: string,
  account: string,
): Promise<boolean> {
  const role = await ethCall(
    factoryAddress,
    encodeCall(factoryAbi, 'PROVISIONER_ROLE', []),
  );
  return wordBool(
    await ethCall(
      factoryAddress,
      encodeCall(factoryAbi, 'hasRole', [role, account]),
    ),
  );
}

async function verifyTenantContracts(
  deployment: FactoryDeployment,
  factory: VerifiedFactoryManifest,
  domain: string,
  owner: string,
  operator: string,
): Promise<void> {
  assertHexAddress('vaultAddress', deployment.vaultAddress);
  assertHexAddress('escrowAddress', deployment.escrowAddress);
  const expectedConfigurationHash = hashWords([owner, operator, owner, owner]);
  if (
    deployment.configurationHash.toLowerCase() !== expectedConfigurationHash
  ) {
    throw new Error(
      'Factory deployment configuration does not match owner roles',
    );
  }
  for (const address of [deployment.vaultAddress, deployment.escrowAddress]) {
    const code = await rpc<string>('eth_getCode', [address, 'latest']);
    if (code === '0x') throw new Error(`No contract bytecode at ${address}`);
    if (!(await explorerSourceVerified(address))) {
      throw new Error(`Contract source is not fully verified at ${address}`);
    }
  }

  await assertCallValue(
    vaultAbi,
    deployment.vaultAddress,
    'organizationDomain',
    [],
    domain,
  );
  await assertCallValue(
    vaultAbi,
    deployment.vaultAddress,
    'token',
    [],
    factory.tokenAddress,
  );
  await assertCallValue(
    vaultAbi,
    deployment.vaultAddress,
    'recoveryAddress',
    [],
    owner,
  );
  await assertPaused(vaultAbi, deployment.vaultAddress);
  await assertRole(vaultAbi, deployment.vaultAddress, 'OWNER_ROLE', owner);
  await assertRole(
    vaultAbi,
    deployment.vaultAddress,
    'OPERATOR_ROLE',
    operator,
  );
  await assertRole(vaultAbi, deployment.vaultAddress, 'PAUSER_ROLE', owner);

  await assertCallValue(
    escrowAbi,
    deployment.escrowAddress,
    'organizationDomain',
    [],
    domain,
  );
  await assertCallValue(
    escrowAbi,
    deployment.escrowAddress,
    'token',
    [],
    factory.tokenAddress,
  );
  await assertCallValue(
    escrowAbi,
    deployment.escrowAddress,
    'vault',
    [],
    deployment.vaultAddress,
  );
  await assertPaused(escrowAbi, deployment.escrowAddress);
  await assertRole(escrowAbi, deployment.escrowAddress, 'ADMIN_ROLE', owner);
  await assertRole(
    escrowAbi,
    deployment.escrowAddress,
    'OPERATOR_ROLE',
    operator,
  );
  await assertRole(escrowAbi, deployment.escrowAddress, 'PAUSER_ROLE', owner);
}

async function assertRole(
  abi: AbiEntry[],
  contract: string,
  roleFunction: string,
  account: string,
): Promise<void> {
  const role = await ethCall(contract, encodeCall(abi, roleFunction, []));
  const granted = await ethCall(
    contract,
    encodeCall(abi, 'hasRole', [role, account]),
  );
  if (!wordBool(granted))
    throw new Error(`${roleFunction} is not assigned correctly`);
}

async function assertPaused(abi: AbiEntry[], contract: string): Promise<void> {
  const value = await ethCall(contract, encodeCall(abi, 'paused', []));
  if (!wordBool(value)) throw new Error(`Contract ${contract} is not paused`);
}

async function assertCallValue(
  abi: AbiEntry[],
  contract: string,
  functionName: string,
  args: string[],
  expected: string,
): Promise<void> {
  const value = await ethCall(contract, encodeCall(abi, functionName, args));
  const normalized = /^0x[0-9a-fA-F]{40}$/.test(expected)
    ? wordAddress(decodeWords(value)[0])
    : `0x${decodeWords(value)[0]}`;
  if (normalized.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${functionName} does not match deployment configuration`);
  }
}

function encodeCall(
  abi: AbiEntry[],
  functionName: string,
  args: string[],
): string {
  const entry = abi.find(
    (item) => item.type === 'function' && item.name === functionName,
  );
  if (!entry?.inputs || entry.inputs.length !== args.length) {
    throw new Error(`ABI function ${functionName} was not found`);
  }
  const signature = `${functionName}(${entry.inputs.map((input) => input.type).join(',')})`;
  const selector = Buffer.from(
    keccak_256(new TextEncoder().encode(signature)),
  ).subarray(0, 4);
  const words = entry.inputs.map((input, index) =>
    encodeWord(input.type, args[index]),
  );
  return `0x${Buffer.concat([selector, ...words]).toString('hex')}`;
}

function encodeWord(type: string, value: string): Buffer {
  const text = value.startsWith('0x') ? value.slice(2) : value;
  if (type === 'address' && /^[0-9a-fA-F]{40}$/.test(text)) {
    return Buffer.from(text.padStart(64, '0'), 'hex');
  }
  if (type === 'bytes32' && /^[0-9a-fA-F]{64}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  throw new Error(`Unsupported ${type} ABI value`);
}

function hashWords(addresses: string[]): string {
  const encoded = Buffer.concat(
    addresses.map((address) => encodeWord('address', address)),
  );
  return `0x${Buffer.from(keccak_256(encoded)).toString('hex')}`;
}

function decodeWords(value: string): string[] {
  const text = value.startsWith('0x') ? value.slice(2) : value;
  if (
    text.length === 0 ||
    text.length % 64 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(text)
  ) {
    throw new Error('RPC returned invalid ABI data');
  }
  return text.match(/.{64}/g)!.map((word) => word.toLowerCase());
}

const zeroAddress = '0x0000000000000000000000000000000000000000';

function wordAddress(word: string | undefined): string {
  if (!word || !/^0{24}[0-9a-f]{40}$/.test(word)) {
    throw new Error('RPC returned an invalid address');
  }
  return `0x${word.slice(24)}`;
}

function wordBool(value: string): boolean {
  const word = decodeWords(value)[0];
  if (word === '0'.repeat(64)) return false;
  if (word === `${'0'.repeat(63)}1`) return true;
  throw new Error('RPC returned an invalid boolean');
}

async function ethCall(contract: string, data: string): Promise<string> {
  return rpc<string>('eth_call', [{ to: contract, data }, 'latest']);
}

async function getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
  return rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash]);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.OPES_RPC_ARC_TESTNET?.trim();
  if (!url) throw new Error('OPES_RPC_ARC_TESTNET is not configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Arc RPC returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error)
    throw new Error(`Arc RPC failed: ${body.error.message ?? 'unknown error'}`);
  if (body.result === undefined) throw new Error('Arc RPC returned no result');
  return body.result;
}

async function explorerSourceVerified(address: string): Promise<boolean> {
  const response = await fetch(
    `https://explorer.testnet.arc.io/api/v2/smart-contracts/${address}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) return false;
  const body = (await response.json()) as { is_verified?: boolean };
  return body.is_verified === true;
}

interface BindingWorkRow {
  id: string;
  organization_id: string;
  resource_id: string;
  address: string | null;
  status: string;
  metadata: Record<string, unknown>;
  owner_wallet_address: string | null;
}

interface ProviderResourceRow {
  id: string;
  provider_resource_id: string | null;
  address: string | null;
  metadata: Record<string, unknown>;
}

interface FactoryDeployment {
  vaultAddress: string;
  escrowAddress: string;
  configurationHash: string;
  transactionHash?: string;
  blockNumber?: number;
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
    private readonly circle: CircleWalletService,
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
      await markSetupRequired(database, result.organizationId);
    });
  }

  async processDueArcProvisioning(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextArcProvisioningEvent();
      if (event === undefined) {
        return processed;
      }

      if (!this.circle.isConfigured()) {
        await this.failProvisioning(event, 'Circle wallets are not configured');
      } else {
        try {
          if (event.event_type === 'agent.wallet.provision.arc_testnet') {
            await this.provisionWallet(event);
          } else {
            await this.provisionContracts(event);
          }
        } catch (error) {
          await this.retryProvisioning(event, errorMessage(error));
        }
      }
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

  private async failProvisioning(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await updateFailedProvisioningBinding(database, event, reason);
      await failOutboxEvent(database, event.id, reason);
    });

    this.logger.warn(`arc provisioning job ${event.id} failed: ${reason}`);
  }

  private async retryProvisioning(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker((database) =>
      database.query(
        `
          UPDATE opes.outbox_events
             SET status = 'PENDING', available_at = now() + interval '30 seconds',
                 payload = payload || jsonb_build_object('lastError', $2::text),
                 updated_at = now()
           WHERE id = $1
        `,
        [event.id, reason],
      ),
    );
    this.logger.warn(`arc provisioning job ${event.id} will retry: ${reason}`);
  }

  private async provisionWallet(event: OutboxEventRow): Promise<void> {
    const duplicateReconciled = await this.database.withWorker(
      async (database) => {
        const result = await database.query<{ active_binding_id: string }>(
          `UPDATE opes.tenant_resource_bindings pending
              SET status = 'DISABLED',
                  metadata = pending.metadata || jsonb_build_object(
                    'replacedByBindingId', active.id::text,
                    'disabledAt', now()
                  ),
                  updated_at = now()
             FROM opes.tenant_resource_bindings active
            WHERE pending.id = $1
              AND pending.organization_id = $2
              AND pending.status = 'PENDING'
              AND active.organization_id = pending.organization_id
              AND active.provider = 'circle'
              AND active.environment = 'arc-testnet'
              AND active.resource_type = 'operator_wallet'
              AND active.status = 'ACTIVE'
              AND active.id <> pending.id
          RETURNING active.id AS active_binding_id`,
          [event.aggregate_id, event.organization_id],
        );
        if (!result.rows[0]) return false;
        await markOutboxProcessed(database, event.id);
        return true;
      },
    );
    if (duplicateReconciled) return;

    const walletSetId = await this.ensureWalletSet();
    await this.ensurePlatformProvisioner(walletSetId);
    const binding = await this.getBinding(event);
    const refId = `opes:tenant:${event.organization_id}:operator:arc-testnet`;
    const wallet =
      (await this.circle.findWallet(refId)) ??
      (await this.circle.createWallet({
        walletSetId,
        refId,
        name: `OPES tenant ${event.organization_id}`,
        idempotencyKey: stableUuid(`circle-wallet:${event.organization_id}`),
      }));
    assertHexAddress('Circle operator wallet', wallet.address);
    const baseRefId = `opes:${event.organization_id}:operator:base-sepolia`;
    const baseWallet = await this.circle.deriveWallet({
      sourceWalletId: wallet.id,
      blockchain: 'BASE-SEPOLIA',
      refId: baseRefId,
      name: 'OPES Base Sepolia operator',
    });
    assertHexAddress('Circle Base operator wallet', baseWallet.address);
    if (baseWallet.address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error('Circle Base wallet does not match Arc operator address');
    }

    await this.database.withWorker(async (database) => {
      const updated = await database.query(
        `
          UPDATE opes.tenant_resource_bindings
             SET resource_id = $3, address = $4, status = 'ACTIVE',
                 metadata = metadata || jsonb_build_object(
                   'walletSetId', $5::text, 'refId', $6::text,
                   'accountType', $7::text, 'activatedAt', now()
                 ), updated_at = now()
           WHERE id = $1 AND organization_id = $2
             AND provider = 'circle' AND resource_type = 'operator_wallet'
             AND (address IS NULL OR lower(address) = lower($4))
          RETURNING id
        `,
        [
          binding.id,
          event.organization_id,
          wallet.id,
          wallet.address,
          walletSetId,
          refId,
          wallet.accountType,
        ],
      );
      if (!updated.rows[0])
        throw new Error('Conflicting Circle operator wallet binding');
      await database.query(
        `INSERT INTO opes.tenant_resource_bindings (
           organization_id, environment, chain_id, provider, resource_type,
           resource_id, address, status, metadata
         ) VALUES ($1, 'base-sepolia', 84532, 'circle', 'operator_wallet',
                   $2, $3, 'ACTIVE', $4::jsonb)
         ON CONFLICT (provider, environment, resource_type, resource_id)
         DO UPDATE SET address = EXCLUDED.address, status = 'ACTIVE',
                       metadata = opes.tenant_resource_bindings.metadata || EXCLUDED.metadata,
                       updated_at = now()`,
        [
          event.organization_id,
          baseWallet.id,
          baseWallet.address,
          JSON.stringify({
            walletSetId,
            refId: baseRefId,
            accountType: baseWallet.accountType,
            derivedFromWalletId: wallet.id,
          }),
        ],
      );
      const provisioning = await ensureFactoryProvisioningBinding(
        database,
        event.organization_id,
        this.factoryManifests.getArcTestnetFactory(),
      );
      await enqueueFactoryProvisioning(
        database,
        event.organization_id,
        provisioning,
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async ensureWalletSet(): Promise<string> {
    const resource = await this.reserveProviderResource(
      'wallet_set',
      'shared',
      stableUuid('circle-wallet-set:arc-testnet'),
    );
    if (resource.provider_resource_id) return resource.provider_resource_id;
    const id = await this.circle.createWalletSet(
      String(resource.metadata.idempotencyKey),
    );
    await this.activateProviderResource(resource.id, id);
    return id;
  }

  private async ensurePlatformProvisioner(walletSetId: string): Promise<void> {
    const refId = 'opes:platform:provisioner:arc-testnet';
    const resource = await this.reserveProviderResource(
      'provisioner_wallet',
      'factory',
      stableUuid(refId),
    );
    if (resource.provider_resource_id && resource.address) {
      await this.ensureProvisionerFunding(resource);
      return;
    }
    const wallet =
      (await this.circle.findWallet(refId)) ??
      (await this.circle.createWallet({
        walletSetId,
        refId,
        name: 'OPES Arc testnet factory provisioner',
        idempotencyKey: String(resource.metadata.idempotencyKey),
      }));
    assertHexAddress('Circle provisioner wallet', wallet.address);
    await this.activateProviderResource(resource.id, wallet.id, wallet.address);
    await this.ensureProvisionerFunding({
      ...resource,
      provider_resource_id: wallet.id,
      address: wallet.address,
    });
  }

  private async ensureProvisionerFunding(
    resource: ProviderResourceRow,
  ): Promise<void> {
    if (resource.metadata.faucetRequestedAt || !resource.address) return;
    const balance = await arcBalance(resource.address);
    if (balance !== undefined && balance >= 500_000_000_000_000_000n) {
      await this.database.withWorker((database) =>
        database.query(
          `UPDATE opes.provider_resources
              SET metadata = metadata || jsonb_build_object(
                    'fundingCheckedAt', now(), 'gasBalanceAtomic', $2::text
                  ), updated_at = now()
            WHERE id = $1`,
          [resource.id, balance.toString()],
        ),
      );
      return;
    }
    await this.circle.requestArcTestnetTokens(resource.address);
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.provider_resources
            SET metadata = metadata || jsonb_build_object('faucetRequestedAt', now()),
                updated_at = now()
          WHERE id = $1`,
        [resource.id],
      ),
    );
  }

  private async reserveProviderResource(
    resourceType: string,
    resourceKey: string,
    idempotencyKey: string,
  ): Promise<ProviderResourceRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<ProviderResourceRow>(
        `
          INSERT INTO opes.provider_resources (
            provider, environment, resource_type, resource_key, metadata
          ) VALUES ('circle', 'arc-testnet', $1, $2,
                    jsonb_build_object('idempotencyKey', $3::text))
          ON CONFLICT (provider, environment, resource_type, resource_key)
          DO UPDATE SET updated_at = opes.provider_resources.updated_at
          RETURNING id, provider_resource_id, address, metadata
        `,
        [resourceType, resourceKey, idempotencyKey],
      );
      return requireRow(result.rows[0], 'Circle provider resource');
    });
  }

  private async activateProviderResource(
    id: string,
    providerResourceId: string,
    address?: string,
  ): Promise<void> {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.provider_resources
            SET provider_resource_id = $2, address = COALESCE($3, address),
                status = 'ACTIVE', updated_at = now()
          WHERE id = $1
            AND (provider_resource_id IS NULL OR provider_resource_id = $2)`,
        [id, providerResourceId, address ?? null],
      ),
    );
  }

  private async getBinding(event: OutboxEventRow): Promise<BindingWorkRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<BindingWorkRow>(
        `SELECT binding.id, binding.organization_id, binding.resource_id,
                binding.address, binding.status, binding.metadata,
                app_user.owner_wallet_address
           FROM opes.tenant_resource_bindings binding
           JOIN opes.organization_memberships membership
             ON membership.organization_id = binding.organization_id
            AND membership.role = 'OWNER' AND membership.status = 'ACTIVE'
           JOIN opes.app_users app_user ON app_user.id = membership.user_id
          WHERE binding.id = $1 AND binding.organization_id = $2
          FOR UPDATE OF binding`,
        [event.aggregate_id, event.organization_id],
      );
      return requireRow(result.rows[0], 'provisioning binding');
    });
  }

  private async provisionContracts(event: OutboxEventRow): Promise<void> {
    const binding = await this.getBinding(event);
    if (!binding.owner_wallet_address)
      throw new Error('Owner wallet is not bound');
    const resources = await this.database.withWorker((database) =>
      database.query<ProviderResourceRow>(
        `SELECT id, provider_resource_id, address, metadata
           FROM opes.provider_resources
          WHERE provider = 'circle' AND environment = 'arc-testnet'
            AND resource_type = 'provisioner_wallet' AND resource_key = 'factory'
            AND status = 'ACTIVE'`,
      ),
    );
    const provisioner = requireRow(
      resources.rows[0],
      'Circle provisioner wallet',
    );
    if (!provisioner.provider_resource_id || !provisioner.address) {
      throw new Error('Circle provisioner wallet is incomplete');
    }
    const operator = await this.database.withWorker((database) =>
      database.query<{ address: string }>(
        `SELECT address FROM opes.tenant_resource_bindings
          WHERE organization_id = $1 AND provider = 'circle'
            AND environment = 'arc-testnet' AND resource_type = 'operator_wallet'
            AND status = 'ACTIVE'`,
        [event.organization_id],
      ),
    );
    const operatorAddress = requireRow(
      operator.rows[0],
      'operator wallet',
    ).address;
    const factory = this.factoryManifests.getArcTestnetFactory();
    const domain = organizationDomain(event.organization_id, 'arc-testnet');
    const deployment = await readFactoryDeployment(
      factory.factoryAddress,
      domain,
    );
    if (deployment) {
      await this.verifyAndRecordDeployment(
        event,
        binding,
        deployment,
        factory,
        operatorAddress,
      );
      return;
    }
    if (
      !(await hasFactoryProvisionerRole(
        factory.factoryAddress,
        provisioner.address,
      ))
    ) {
      await this.failProvisioning(
        event,
        `Grant PROVISIONER_ROLE to ${provisioner.address} and fund its Arc testnet gas`,
      );
      return;
    }

    const transactionId = textMetadata(binding.metadata.circleTransactionId);
    if (!transactionId) {
      const transaction = await this.circle.createFactoryTransaction({
        walletId: provisioner.provider_resource_id,
        factoryAddress: factory.factoryAddress,
        organizationDomain: domain,
        owner: binding.owner_wallet_address,
        operator: operatorAddress,
        idempotencyKey: stableUuid(`factory:${event.organization_id}`),
      });
      await this.saveFactoryTransaction(binding.id, transaction.id);
      await this.retryProvisioning(
        event,
        `Circle transaction ${transaction.id} is ${transaction.state}`,
      );
      return;
    }
    const transaction = await this.circle.getTransaction(transactionId);
    if (
      ['FAILED', 'CANCELLED', 'DENIED', 'STUCK'].includes(transaction.state)
    ) {
      await this.failProvisioning(
        event,
        `Circle transaction ${transactionId} ${transaction.state}`,
      );
      return;
    }
    if (!transaction.txHash) {
      await this.retryProvisioning(
        event,
        `Circle transaction ${transactionId} is ${transaction.state}`,
      );
      return;
    }
    const receipt = await getTransactionReceipt(transaction.txHash);
    if (!receipt) {
      await this.retryProvisioning(
        event,
        `Arc transaction ${transaction.txHash} is pending`,
      );
      return;
    }
    if (receipt.status !== '0x1') {
      await this.failProvisioning(
        event,
        `Arc transaction ${transaction.txHash} reverted`,
      );
      return;
    }
    const created = await readFactoryDeployment(factory.factoryAddress, domain);
    if (!created)
      throw new Error('Factory receipt has no registered deployment');
    await this.verifyAndRecordDeployment(
      event,
      binding,
      {
        ...created,
        transactionHash: transaction.txHash,
        blockNumber: Number.parseInt(receipt.blockNumber, 16),
      },
      factory,
      operatorAddress,
    );
  }

  private async verifyAndRecordDeployment(
    event: OutboxEventRow,
    binding: BindingWorkRow,
    deployment: FactoryDeployment,
    factory: VerifiedFactoryManifest,
    operatorAddress: string,
  ): Promise<void> {
    let transactionHash = deployment.transactionHash;
    let blockNumber = deployment.blockNumber;
    if (!transactionHash || blockNumber === undefined) {
      const transactionId = textMetadata(binding.metadata.circleTransactionId);
      if (!transactionId) {
        throw new Error(
          'Existing factory deployment has no persisted transaction evidence',
        );
      }
      const transaction = await this.circle.getTransaction(transactionId);
      if (!transaction.txHash)
        throw new Error('Factory transaction hash is pending');
      const receipt = await getTransactionReceipt(transaction.txHash);
      if (!receipt || receipt.status !== '0x1') {
        throw new Error('Factory transaction receipt is pending or failed');
      }
      transactionHash = transaction.txHash;
      blockNumber = Number.parseInt(receipt.blockNumber, 16);
    }

    await verifyTenantContracts(
      deployment,
      factory,
      organizationDomain(event.organization_id, 'arc-testnet'),
      binding.owner_wallet_address!,
      operatorAddress,
    );
    await this.recordArcProvisioningSuccess({
      organizationId: event.organization_id,
      provisioningBindingId: binding.id,
      vaultAddress: deployment.vaultAddress,
      escrowAddress: deployment.escrowAddress,
      transactionHash,
      blockNumber,
      sourceVerification: 'fully_verified',
    });
    await this.database.withWorker((database) =>
      markOutboxProcessed(database, event.id),
    );
  }

  private async saveFactoryTransaction(
    bindingId: string,
    transactionId: string,
  ): Promise<void> {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.tenant_resource_bindings
          SET metadata = metadata || jsonb_build_object('circleTransactionId', $2::text), updated_at = now()
        WHERE id = $1`,
        [bindingId, transactionId],
      ),
    );
  }
}

async function arcBalance(address: string): Promise<bigint | undefined> {
  if (!process.env.OPES_RPC_ARC_TESTNET?.trim()) return undefined;
  return BigInt(await rpc<string>('eth_getBalance', [address, 'latest']));
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
        $1::uuid,
        'arc-testnet',
        5042002,
        'arc',
        $2,
        $1::text,
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

async function markSetupRequired(
  database: TenantDatabase,
  organizationId: string,
): Promise<void> {
  await database.query(
    `
      WITH organization_update AS (
        UPDATE opes.organizations
           SET lifecycle_status = 'SETUP_REQUIRED',
               updated_at = now()
         WHERE id = $1
           AND lifecycle_status = 'PROVISIONING'
         RETURNING id
      )
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
