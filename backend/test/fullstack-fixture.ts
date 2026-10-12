import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

const ids = {
  user: '90000000-0000-4000-8000-000000000001',
  organization: '90000000-0000-4000-8000-000000000002',
  membership: '90000000-0000-4000-8000-000000000003',
  agent: '90000000-0000-4000-8000-000000000004',
  vendor: '90000000-0000-4000-8000-000000000005',
  address: '90000000-0000-4000-8000-000000000006',
  document: '90000000-0000-4000-8000-000000000007',
  obligation: '90000000-0000-4000-8000-000000000008',
  invoice: '90000000-0000-4000-8000-000000000009',
  audit: '90000000-0000-4000-8000-000000000010',
};
const sessionToken = 'opes-p9-fullstack-session';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });

async function main() {
  try {
    await cleanup();
    if (process.argv[2] === 'seed') {
      await seed();
      process.stdout.write(
        JSON.stringify({ sessionToken, organizationId: ids.organization }),
      );
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function seed() {
  await pool.query(
    `INSERT INTO opes.app_users (id, email, display_name) VALUES ($1, 'p9-fullstack@example.com', 'P9 Fixture Owner')`,
    [ids.user],
  );
  await organizationTransaction(async (client) => {
    await client.query(
      `INSERT INTO opes.organizations (id, slug, display_name, lifecycle_status) VALUES ($1, 'p9-fullstack', 'P9 Full-stack Fixture', 'SETUP_REQUIRED')`,
      [ids.organization],
    );
    await client.query(
      `INSERT INTO opes.organization_memberships (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')`,
      [ids.membership, ids.organization, ids.user],
    );
    await client.query(
      `INSERT INTO opes.business_agents (id, organization_id, lifecycle_status) VALUES ($1, $2, 'SETUP_REQUIRED')`,
      [ids.agent, ids.organization],
    );
    await client.query(
      `INSERT INTO opes.vendors (id, organization_id, display_name, status, created_by_membership_id) VALUES ($1, $2, 'Railway Catering', 'VERIFIED', $3)`,
      [ids.vendor, ids.organization, ids.membership],
    );
    await client.query(
      `INSERT INTO opes.vendor_payout_addresses
        (id, organization_id, vendor_id, environment, chain_id, asset_symbol, asset_address, payout_address, status, version, created_by_membership_id)
       VALUES ($1, $2, $3, 'arc-testnet', 5042002, 'USDC', '0x3600000000000000000000000000000000000000', '0x4000000000000000000000000000000000000004', 'VERIFIED_ACTIVE', 1, $4)`,
      [ids.address, ids.organization, ids.vendor, ids.membership],
    );
    await client.query(
      `INSERT INTO opes.evidence_documents
        (id, organization_id, document_type, filename, content_type, size_bytes, sha256_hex, storage_key, created_by_membership_id)
       VALUES ($1, $2, 'INVOICE', 'railway-catering.txt', 'text/plain', 10, $3, 'fixtures/p9/invoice', $4)`,
      [ids.document, ids.organization, 'a'.repeat(64), ids.membership],
    );
    await client.query(
      `INSERT INTO opes.payable_obligations (id, organization_id, vendor_id, source_reference, obligation_key, created_by_membership_id) VALUES ($1, $2, $3, 'INV-P9-001', $4, $5)`,
      [
        ids.obligation,
        ids.organization,
        ids.vendor,
        'b'.repeat(64),
        ids.membership,
      ],
    );
    await client.query(
      `INSERT INTO opes.payable_obligation_versions
        (id, organization_id, obligation_id, version, evidence_document_id, vendor_id, vendor_address_id,
         invoice_number, currency, amount_atomic, amount_decimals, line_items, content_hash, created_by_membership_id)
       VALUES ($1, $2, $3, 1, $4, $5, $6, 'INV-P9-001', 'USDC', 125000000, 6, '[]', $7, $8)`,
      [
        ids.invoice,
        ids.organization,
        ids.obligation,
        ids.document,
        ids.vendor,
        ids.address,
        'c'.repeat(64),
        ids.membership,
      ],
    );
    await client.query(
      `INSERT INTO opes.audit_events (id, organization_id, actor_user_id, actor_membership_id, event_type, subject_type, subject_id, payload) VALUES ($1, $2, $3, $4, 'invoice.verified', 'PAYABLE_OBLIGATION_VERSION', $5, '{"fixture":true}')`,
      [ids.audit, ids.organization, ids.user, ids.membership, ids.invoice],
    );
  });
  await pool.query(
    `INSERT INTO opes.user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [ids.user, createHash('sha256').update(sessionToken).digest('hex')],
  );
}

async function cleanup() {
  await organizationTransaction(async (client) => {
    for (const table of [
      'audit_events',
      'payable_obligation_versions',
      'payable_obligations',
      'evidence_documents',
      'vendor_payout_addresses',
      'vendors',
      'business_agents',
      'organization_memberships',
    ]) {
      await client.query(
        `DELETE FROM opes.${table} WHERE organization_id = $1`,
        [ids.organization],
      );
    }
    await client.query('DELETE FROM opes.organizations WHERE id = $1', [
      ids.organization,
    ]);
  });
  await pool.query('DELETE FROM opes.user_sessions WHERE user_id = $1', [
    ids.user,
  ]);
  await pool.query('DELETE FROM opes.app_users WHERE id = $1', [ids.user]);
}

async function organizationTransaction(
  work: (client: PoolClient) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('opes.organization_id', $1, true)", [
      ids.organization,
    ]);
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
