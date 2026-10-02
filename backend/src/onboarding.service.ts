import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { SessionService } from './session.service';

export interface OnboardingRequest {
  email: string;
  displayName: string;
  organizationName: string;
  organizationSlug?: string;
}

export interface OnboardingResult {
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
  membership: {
    id: string;
    role: 'OWNER';
  };
  agent: {
    id: string;
    lifecycleStatus: string;
  };
  sessionToken: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
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

@Injectable()
export class OnboardingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  async onboard(input: OnboardingRequest): Promise<OnboardingResult> {
    const email = normalizeEmail(input.email);
    const displayName = requireText(input.displayName, 'displayName');
    const organizationName = requireText(
      input.organizationName,
      'organizationName',
    );
    const organizationSlug = makeSlug(
      input.organizationSlug ?? organizationName,
    );

    return this.database.withTransaction(async (database) => {
      const user = await upsertUser(database, email, displayName);
      const organization = await getOrCreateOrganization(
        database,
        organizationSlug,
        organizationName,
      );
      const membership = await getOrCreateOwnerMembership(
        database,
        organization,
        user.id,
      );
      const agent = await getOrCreatePrimaryAgent(database, organization.id);
      const sessionToken = await this.sessions.createSessionRecord(
        database,
        user.id,
      );

      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
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
        sessionToken,
      };
    });
  }
}

async function upsertUser(
  database: TenantDatabase,
  email: string,
  displayName: string,
): Promise<UserRow> {
  const result = await database.query<UserRow>(
    `
      INSERT INTO opes.app_users (email, display_name)
      VALUES ($1, $2)
      ON CONFLICT (email_normalized)
      DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
      RETURNING id, email, display_name
    `,
    [email, displayName],
  );

  return requireRow(result.rows[0], 'user');
}

async function getOrCreateOrganization(
  database: TenantDatabase,
  slug: string,
  displayName: string,
): Promise<OrganizationRow> {
  const inserted = await database.query<OrganizationRow>(
    `
      INSERT INTO opes.organizations (slug, display_name, lifecycle_status)
      VALUES ($1, $2, 'PROVISIONING')
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, slug, display_name, lifecycle_status
    `,
    [slug, displayName],
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

  return requireRow(existing.rows[0], 'organization');
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

function normalizeEmail(value: string): string {
  const email = requireText(value, 'email').toLowerCase();
  if (!email.includes('@')) {
    throw new BadRequestException('email must be valid');
  }

  return email;
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

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${name} row`);
  }

  return row;
}
