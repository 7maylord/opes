import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from '../integrations/connector-credentials';

const allowedScopes = new Set(['invoices:read', 'payments:read']);
const allowedEvents = new Set([
  '*',
  'PAYMENT_SETTLED',
  'PAYMENT_FAILED',
  'APPROVAL_REQUIRED',
  'INVOICE_RECEIVED',
  'AGREEMENT_CHANGED',
]);
interface EndpointRow {
  id: string;
  url: string;
  description: string;
  signing_secret_encrypted: string;
  event_types: string[];
  status: string;
  created_at: Date;
}
interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  response_status: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

@Injectable()
export class DeveloperPlatformService {
  constructor(private readonly database: DatabaseService) {}
  async listCredentials(context: TenantContext) {
    return this.database.withTenant(context, (db) =>
      db
        .query<{
          id: string;
          name: string;
          key_prefix: string;
          scopes: string[];
          status: string;
          last_used_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id,name,key_prefix,scopes,status,last_used_at,created_at FROM opes.api_credentials WHERE organization_id=$1 ORDER BY created_at DESC`,
          [context.organizationId],
        )
        .then((r) =>
          r.rows.map((row) => ({
            id: row.id,
            name: row.name,
            keyPrefix: row.key_prefix,
            scopes: row.scopes,
            status: row.status,
            lastUsedAt: row.last_used_at,
            createdAt: row.created_at,
          })),
        ),
    );
  }
  async createCredential(
    context: TenantContext,
    input: { name: string; scopes: string[] },
  ) {
    requireOwner(context);
    const name = input.name?.trim();
    if (!name || name.length > 80)
      throw new BadRequestException(
        'name is required and cannot exceed 80 characters',
      );
    const scopes = [...new Set(input.scopes ?? [])];
    if (!scopes.length || scopes.some((scope) => !allowedScopes.has(scope)))
      throw new BadRequestException('scopes contain an unsupported value');
    const secret = `opes_${randomBytes(32).toString('base64url')}`;
    const result = await this.database.withTenant(context, (db) =>
      db.query<{ id: string }>(
        `INSERT INTO opes.api_credentials(organization_id,name,key_hash,key_prefix,scopes,created_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
        [
          context.organizationId,
          name,
          hash(secret),
          secret.slice(0, 12),
          JSON.stringify(scopes),
          context.membershipId,
        ],
      ),
    );
    return {
      id: result.rows[0].id,
      name,
      keyPrefix: secret.slice(0, 12),
      scopes,
      status: 'ACTIVE',
      secret,
    };
  }
  async revokeCredential(context: TenantContext, id: string) {
    requireOwner(context);
    requireUuid(id, 'credentialId');
    const result = await this.database.withTenant(context, (db) =>
      db.query(
        `UPDATE opes.api_credentials SET status='REVOKED',revoked_at=now() WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id`,
        [context.organizationId, id],
      ),
    );
    if (!result.rows[0])
      throw new NotFoundException('Active API credential not found');
    return { revoked: true };
  }
  async authenticate(
    organizationId: string,
    secret: string | undefined,
    scope: string,
  ) {
    requireUuid(organizationId, 'organizationId');
    if (!secret) throw new ForbiddenException('X-OPES-API-Key is required');
    await this.database.withOrganizationScope(organizationId, async (db) => {
      const row = (
        await db.query<{ id: string; scopes: string[] }>(
          `UPDATE opes.api_credentials SET last_used_at=now() WHERE organization_id=$1 AND key_hash=$2 AND status='ACTIVE' RETURNING id,scopes`,
          [organizationId, hash(secret)],
        )
      ).rows[0];
      if (!row || !row.scopes.includes(scope))
        throw new ForbiddenException(
          'API credential is invalid or missing scope',
        );
    });
  }
  async publicInvoices(organizationId: string, secret: string | undefined) {
    await this.authenticate(organizationId, secret, 'invoices:read');
    return this.database.withOrganizationScope(organizationId, (db) =>
      db
        .query(
          `SELECT DISTINCT ON(version.obligation_id) version.id,version.invoice_number AS "invoiceNumber",version.amount_atomic::text AS "amountAtomic",version.currency,version.status,version.due_at AS "dueAt",version.created_at AS "createdAt" FROM opes.payable_obligation_versions version WHERE version.organization_id=$1 ORDER BY version.obligation_id,version.version DESC`,
          [organizationId],
        )
        .then((r) => r.rows),
    );
  }
  async publicPayments(organizationId: string, secret: string | undefined) {
    await this.authenticate(organizationId, secret, 'payments:read');
    return this.database.withOrganizationScope(organizationId, (db) =>
      db
        .query(
          `SELECT id,status,amount_atomic::text AS "amountAtomic",route_asset_symbol AS "assetSymbol",route_environment AS network,transaction_hash AS "transactionHash",confirmed_at AS "confirmedAt",requested_at AS "requestedAt" FROM opes.payment_executions WHERE organization_id=$1 ORDER BY requested_at DESC LIMIT 100`,
          [organizationId],
        )
        .then((result) => result.rows),
    );
  }
  async listEndpoints(context: TenantContext) {
    return this.database.withTenant(context, (db) =>
      db
        .query<EndpointRow>(
          `SELECT id,url,description,signing_secret_encrypted,event_types,status,created_at FROM opes.webhook_endpoints WHERE organization_id=$1 ORDER BY created_at DESC`,
          [context.organizationId],
        )
        .then((r) => r.rows.map(mapEndpoint)),
    );
  }
  async createEndpoint(
    context: TenantContext,
    input: { url: string; description: string; eventTypes: string[] },
  ) {
    requireOwner(context);
    const url = validateWebhookUrl(input.url);
    const events = [...new Set(input.eventTypes ?? [])];
    if (!events.length || events.some((event) => !allowedEvents.has(event)))
      throw new BadRequestException('eventTypes contain an unsupported value');
    const id = randomUUID();
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const encrypted = encryptConnectorCredentials(context.organizationId, id, {
      secret,
    });
    const result = await this.database.withTenant(context, (db) =>
      db.query<EndpointRow>(
        `INSERT INTO opes.webhook_endpoints(id,organization_id,url,description,signing_secret_encrypted,event_types,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id,url,description,signing_secret_encrypted,event_types,status,created_at`,
        [
          id,
          context.organizationId,
          url,
          input.description?.trim().slice(0, 200) ?? '',
          encrypted,
          JSON.stringify(events),
          context.membershipId,
        ],
      ),
    );
    return { ...mapEndpoint(result.rows[0]), signingSecret: secret };
  }
  async disableEndpoint(context: TenantContext, id: string) {
    requireOwner(context);
    requireUuid(id, 'endpointId');
    const result = await this.database.withTenant(context, (db) =>
      db.query(
        `UPDATE opes.webhook_endpoints SET status='DISABLED',disabled_at=now() WHERE organization_id=$1 AND id=$2 AND status='ACTIVE' RETURNING id`,
        [context.organizationId, id],
      ),
    );
    if (!result.rows[0])
      throw new NotFoundException('Active webhook endpoint not found');
    return { disabled: true };
  }
  async testEndpoint(context: TenantContext, id: string) {
    requireOwner(context);
    requireUuid(id, 'endpointId');
    await this.database.withTenant(context, (db) =>
      enqueueWebhookEvent(
        db,
        context.organizationId,
        'WEBHOOK_TEST',
        `test:${randomUUID()}`,
        { message: 'OPES webhook test' },
        id,
      ),
    );
    return { queued: true };
  }
  async listDeliveries(context: TenantContext) {
    return this.database.withTenant(context, (db) =>
      db
        .query<DeliveryRow>(
          `SELECT id,endpoint_id,event_id,event_type,status,attempt_count,response_status,last_error,delivered_at,created_at FROM opes.webhook_deliveries WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [context.organizationId],
        )
        .then((r) => r.rows.map(mapDelivery)),
    );
  }
}

export async function enqueueWebhookEvent(
  db: TenantDatabase,
  organizationId: string,
  eventType: string,
  eventKey: string,
  payload: unknown,
  onlyEndpointId?: string,
) {
  await db.query(
    `INSERT INTO opes.webhook_deliveries(organization_id,endpoint_id,event_key,event_type,payload) SELECT $1,endpoint.id,$2,$3,$4::jsonb FROM opes.webhook_endpoints endpoint WHERE endpoint.organization_id=$1 AND endpoint.status='ACTIVE' AND ($5::uuid IS NULL OR endpoint.id=$5) AND ($5::uuid IS NOT NULL OR endpoint.event_types?'*' OR endpoint.event_types?$3) ON CONFLICT(endpoint_id,event_key) DO NOTHING`,
    [
      organizationId,
      eventKey,
      eventType,
      JSON.stringify(payload),
      onlyEndpointId ?? null,
    ],
  );
}
export function signWebhook(secret: string, timestamp: string, body: string) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}
function mapEndpoint(row: EndpointRow) {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    createdAt: row.created_at,
  };
}
function mapDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    attemptCount: row.attempt_count,
    responseStatus: row.response_status,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function requireOwner(context: TenantContext) {
  if (context.role !== 'OWNER')
    throw new ForbiddenException('Only owners can manage developer access');
}
function requireUuid(value: string, field: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException(`${field} must be a UUID`);
}
function validateWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('url must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:')
    throw new BadRequestException('url must use HTTPS');
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname))
    throw new BadRequestException('local webhook URLs are not allowed');
  return url.toString();
}
export function decryptWebhookSecret(
  organizationId: string,
  endpoint: EndpointRow,
) {
  return decryptConnectorCredentials<{ secret: string }>(
    organizationId,
    endpoint.id,
    endpoint.signing_secret_encrypted,
  ).secret;
}
