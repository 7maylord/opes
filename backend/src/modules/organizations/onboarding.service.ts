import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { SessionUser } from '../../core/auth/session.service';

export interface OnboardingRequest {
  organizationName: string;
  organizationSlug?: string;
}

export interface OnboardingResult {
  user: {
    id: string;
    email: string;
    displayName: string;
    ownerWalletAddress: string;
  };
  organization: {
    id: string;
    slug: string;
    displayName: string;
    lifecycleStatus: string;
  };
  membership: {
    id: string;
    role: 'OWNER';
  };
  agent: {
    id: string;
    lifecycleStatus: string;
  };
}

interface OrganizationRow {
  id: string;
  slug: string;
  display_name: string;
  lifecycle_status: string;
}

interface MembershipRow {
  id: string;
  role: 'OWNER';
  status: string;
}

interface AgentRow {
  id: string;
  lifecycle_status: string;
}

interface GlobalIdempotencyRecordRow {
  request_hash: string;
  status: string;
}

@Injectable()
export class OnboardingService {
  constructor(private readonly database: DatabaseService) {}

  async onboard(
    user: SessionUser,
    input: OnboardingRequest,
    idempotencyKey?: string,
  ): Promise<OnboardingResult> {
    const organizationName = requireText(
      input.organizationName,
      'organizationName',
    );
    const organizationSlug = makeSlug(
      input.organizationSlug ?? organizationName,
    );
    const request = {
      userId: user.id,
      ownerWalletAddress: user.ownerWalletAddress,
      organizationName,
      organizationSlug,
    };
    if (user.ownerWalletAddress === null) {
      throw new ConflictException('Owner wallet setup is incomplete');
    }
    const ownerWalletAddress = user.ownerWalletAddress;

    const organizationId = randomUUID();
    return this.database.withTransaction(async (database) => {
      await database.query("SELECT set_config('opes.user_id', $1, true)", [
        user.id,
      ]);
      await database.query(
        "SELECT set_config('opes.organization_id', $1, true)",
        [organizationId],
      );
      await reserveGlobalIdempotency(
        database,
        'POST /onboarding',
        idempotencyKey,
        request,
      );
      const organization = await getOrCreateOrganization(
        database,
        organizationId,
        organizationSlug,
        organizationName,
      );
      await database.query(
        "SELECT set_config('opes.organization_id', $1, true)",
        [organization.id],
      );
      const membership = await getOrCreateOwnerMembership(
        database,
        organization,
        user.id,
      );
      const agent = await getOrCreatePrimaryAgent(database, organization.id);
      await ensureArcOperatorWalletProvisioning(database, organization.id);
      await completeGlobalIdempotency(
        database,
        'POST /onboarding',
        idempotencyKey,
      );

      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          ownerWalletAddress,
        },
        organization: {
          id: organization.id,
          slug: organization.slug,
          displayName: organization.display_name,
          lifecycleStatus: organization.lifecycle_status,
        },
        membership: {
          id: membership.id,
          role: 'OWNER',
        },
        agent: {
          id: agent.id,
          lifecycleStatus: agent.lifecycle_status,
        },
      };
    });
  }
}

async function reserveGlobalIdempotency(
  database: TenantDatabase,
  route: string,
  key: string | undefined,
  request: unknown,
): Promise<void> {
  const idempotencyKey = key?.trim();
  if (idempotencyKey === undefined || idempotencyKey === '') {
    return;
  }
  if (idempotencyKey.length > 200) {
    throw new BadRequestException('idempotency key is too long');
  }

  const requestHash = hashJson(request);
  const inserted = await database.query(
    `
      INSERT INTO opes.global_idempotency_records (
        route,
        idempotency_key,
        request_hash
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (route, idempotency_key) DO NOTHING
    `,
    [route, idempotencyKey, requestHash],
  );

  if (inserted.rowCount !== 0) {
    return;
  }

  const existing = await database.query<GlobalIdempotencyRecordRow>(
    `
      SELECT request_hash, status
        FROM opes.global_idempotency_records
       WHERE route = $1
         AND idempotency_key = $2
    `,
    [route, idempotencyKey],
  );
  const record = existing.rows[0];
  if (record?.request_hash !== requestHash) {
    throw new ConflictException(
      'Idempotency key was used with a different request',
    );
  }
  if (record.status !== 'COMPLETED') {
    throw new ConflictException('Idempotency request is still processing');
  }
}

async function completeGlobalIdempotency(
  database: TenantDatabase,
  route: string,
  key: string | undefined,
): Promise<void> {
  const idempotencyKey = key?.trim();
  if (idempotencyKey === undefined || idempotencyKey === '') {
    return;
  }

  await database.query(
    `
      UPDATE opes.global_idempotency_records
         SET status = 'COMPLETED',
             updated_at = now()
       WHERE route = $1
         AND idempotency_key = $2
    `,
    [route, idempotencyKey],
  );
}

async function getOrCreateOrganization(
  database: TenantDatabase,
  organizationId: string,
  slug: string,
  displayName: string,
): Promise<OrganizationRow> {
  const inserted = await database.query<OrganizationRow>(
    `
      INSERT INTO opes.organizations (id, slug, display_name, lifecycle_status)
      VALUES ($1, $2, $3, 'PROVISIONING')
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug, display_name, lifecycle_status
    `,
    [organizationId, slug, displayName],
  );

  if (inserted.rows[0] !== undefined) {
    return inserted.rows[0];
  }

  const existing = await database.query<OrganizationRow>(
    `
      SELECT id, slug, display_name, lifecycle_status
        FROM opes.organizations
       WHERE slug = $1
    `,
    [slug],
  );
  const organization = existing.rows[0];
  if (!organization)
    throw new ConflictException('Organization slug is already in use');
  return organization;
}

async function getOrCreateOwnerMembership(
  database: TenantDatabase,
  organization: OrganizationRow,
  userId: string,
): Promise<MembershipRow> {
  const existing = await database.query<MembershipRow>(
    `
      SELECT id, role, status
        FROM opes.organization_memberships
       WHERE organization_id = $1
         AND user_id = $2
    `,
    [organization.id, userId],
  );

  const membership = existing.rows[0];
  if (membership !== undefined) {
    if (membership.status !== 'ACTIVE' || membership.role !== 'OWNER') {
      throw new ConflictException(
        'Existing organization membership is inactive',
      );
    }

    return membership;
  }

  const anyMembership = await database.query(
    `
      SELECT id
        FROM opes.organization_memberships
       WHERE organization_id = $1
       LIMIT 1
    `,
    [organization.id],
  );
  if (anyMembership.rows.length > 0) {
    throw new ConflictException('Organization slug is already in use');
  }

  const inserted = await database.query<MembershipRow>(
    `
      INSERT INTO opes.organization_memberships (
        organization_id,
        user_id,
        role,
        status
      )
      VALUES ($1, $2, 'OWNER', 'ACTIVE')
      RETURNING id, role, status
    `,
    [organization.id, userId],
  );

  return requireRow(inserted.rows[0], 'membership');
}

async function getOrCreatePrimaryAgent(
  database: TenantDatabase,
  organizationId: string,
): Promise<AgentRow> {
  const inserted = await database.query<AgentRow>(
    `
      INSERT INTO opes.business_agents (
        organization_id,
        is_primary,
        lifecycle_status
      )
      SELECT $1, true, 'PROVISIONING'
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.business_agents
         WHERE organization_id = $1
           AND is_primary = true
      )
      RETURNING id, lifecycle_status
    `,
    [organizationId],
  );

  if (inserted.rows[0] !== undefined) {
    return inserted.rows[0];
  }

  const existing = await database.query<AgentRow>(
    `
      SELECT id, lifecycle_status
        FROM opes.business_agents
       WHERE organization_id = $1
         AND is_primary = true
    `,
    [organizationId],
  );

  return requireRow(existing.rows[0], 'agent');
}

async function ensureArcOperatorWalletProvisioning(
  database: TenantDatabase,
  organizationId: string,
): Promise<void> {
  const binding = await database.query<{ id: string; status: string }>(
    `
      WITH existing AS (
        SELECT id, status
          FROM opes.tenant_resource_bindings
         WHERE organization_id = $1
           AND provider = 'circle'
           AND environment = 'arc-testnet'
           AND resource_type = 'operator_wallet'
           AND status IN ('PENDING', 'ACTIVE')
         ORDER BY (status = 'ACTIVE') DESC, created_at
         LIMIT 1
      ), inserted AS (
        INSERT INTO opes.tenant_resource_bindings (
          organization_id, environment, chain_id, provider, resource_type,
          resource_id, status, metadata
        )
        SELECT $1::uuid, 'arc-testnet', 5042002, 'circle', 'operator_wallet',
               $1::text, 'PENDING', '{"purpose":"tenant_operator"}'::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id, status
      )
      SELECT id, status FROM existing
      UNION ALL
      SELECT id, status FROM inserted
      LIMIT 1
    `,
    [organizationId],
  );
  const row = requireRow(binding.rows[0], 'operator wallet binding');
  if (row.status === 'ACTIVE') return;

  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      SELECT $1, 'agent.wallet.provision.arc_testnet', 'tenant_resource_binding', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = 'agent.wallet.provision.arc_testnet'
           AND aggregate_type = 'tenant_resource_binding'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, row.id],
  );
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text === '') {
    throw new BadRequestException(`${name} is required`);
  }

  return text;
}

function makeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug === '') {
    throw new BadRequestException('organizationSlug is required');
  }

  return slug;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${name} row`);
  }

  return row;
}
