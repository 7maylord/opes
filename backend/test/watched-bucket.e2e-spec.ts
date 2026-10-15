import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database.service';
import {
  BucketObject,
  RailwayBucketService,
} from '../src/railway-bucket.service';
import { WatchedBucketService } from '../src/watched-bucket.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('Watched bucket (e2e)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let watcher: WatchedBucketService;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const agentId = randomUUID();
  const objects = new Map<string, ObjectValue>();

  beforeAll(async () => {
    process.env.OPES_BUCKET_STABLE_SECONDS = '0';
    const bucket = {
      isConfigured: () => true,
      list: (prefix: string) =>
        Promise.resolve({
          objects: [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => metadata(key, value)),
        }),
      stat: (key: string) => Promise.resolve(metadata(key, requireObject(key))),
      read: (key: string) => {
        const value = requireObject(key);
        return Promise.resolve({
          bytes: value.bytes,
          contentType: value.contentType,
          sizeBytes: value.bytes.length,
        });
      },
      finalize: (source: string, destination: string, etag?: string) => {
        const value = requireObject(source);
        if (etag && etag !== value.etag) throw new Error('Object changed');
        objects.set(destination, { ...value });
        return Promise.resolve();
      },
      move: (source: string, destination: string) => {
        const value = requireObject(source);
        objects.set(destination, { ...value });
        objects.delete(source);
        return Promise.resolve();
      },
      delete: (key: string) => {
        objects.delete(key);
        return Promise.resolve();
      },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RailwayBucketService)
      .useValue(bucket)
      .compile();
    app = module.createNestApplication();
    await app.init();
    database = app.get(DatabaseService);
    watcher = app.get(WatchedBucketService);
    await database.withDatabase((sql) =>
      sql.query(
        `INSERT INTO opes.app_users(id,email,display_name) VALUES ($1,$2,'Bucket Owner')`,
        [userId, `bucket-${userId}@example.com`],
      ),
    );
    await database.withOrganizationScope(organizationId, async (sql) => {
      await sql.query(
        `INSERT INTO opes.organizations(id,slug,display_name,lifecycle_status) VALUES ($1,$2,'Bucket Org','ACTIVE')`,
        [organizationId, `bucket-${organizationId}`],
      );
      await sql.query(
        `INSERT INTO opes.organization_memberships(id,organization_id,user_id,role,status) VALUES ($1,$2,$3,'OWNER','ACTIVE')`,
        [membershipId, organizationId, userId],
      );
      await sql.query(
        `INSERT INTO opes.business_agents(id,organization_id,lifecycle_status) VALUES ($1,$2,'ACTIVE')`,
        [agentId, organizationId],
      );
    });
  });

  it('waits for stability, detects replacement, deduplicates relists and quarantines invalid bindings', async () => {
    const key = `inbox/${organizationId}/INVOICE/invoice.txt`;
    put(key, 'partial');
    expect(await watcher.processDue()).toBe(0);
    put(key, 'complete invoice');
    expect(await watcher.processDue()).toBe(0);
    expect(await documentCount()).toBe('0');
    expect(await watcher.processDue()).toBe(1);
    expect(await documentCount()).toBe('1');
    expect(
      [...objects.keys()].some((value) =>
        value.startsWith(`processed/${organizationId}/INVOICE/`),
      ),
    ).toBe(true);

    put(
      key,
      'complete invoice',
      requireObject(
        [...objects.keys()].find((value) => value.startsWith('processed/'))!,
      ).lastModified,
    );
    expect(await watcher.processDue()).toBe(0);
    expect(await documentCount()).toBe('1');

    const badType = `inbox/${organizationId}/EXECUTABLE/payload.bin`;
    const badTenant = `inbox/${randomUUID()}/INVOICE/unknown.txt`;
    put(badType, 'bad');
    put(badTenant, 'unknown');
    await watcher.processDue();
    expect(await watcher.processDue()).toBe(2);
    expect(
      [...objects.keys()].filter((value) => value.startsWith('quarantine/')),
    ).toHaveLength(2);
    const reasons = await database.withWorker((sql) =>
      sql.query<{ quarantine_reason: string }>(
        `SELECT quarantine_reason FROM opes.watched_bucket_objects WHERE source_key IN ($1,$2) ORDER BY quarantine_reason`,
        [badType, badTenant],
      ),
    );
    expect(reasons.rows.map((row) => row.quarantine_reason)).toEqual([
      'UNKNOWN_ORGANIZATION',
      'UNSUPPORTED_DOCUMENT_TYPE',
    ]);
  });

  afterAll(async () => {
    delete process.env.OPES_BUCKET_STABLE_SECONDS;
    await database.withWorker(async (sql) => {
      await sql.query(
        `DELETE FROM opes.watched_bucket_objects WHERE organization_id=$1 OR source_key LIKE $2`,
        [organizationId, 'inbox/%'],
      );
      await sql.query(
        `DELETE FROM opes.watched_bucket_cursors WHERE prefix='inbox/'`,
      );
    });
    await database.withOrganizationScope(organizationId, async (sql) => {
      for (const table of [
        'audit_events',
        'intake_envelopes',
        'evidence_documents',
        'business_agents',
        'organization_memberships',
      ])
        await sql.query(`DELETE FROM opes.${table} WHERE organization_id=$1`, [
          organizationId,
        ]);
      await sql.query('DELETE FROM opes.organizations WHERE id=$1', [
        organizationId,
      ]);
    });
    await database.withDatabase(async (sql) => {
      await sql.query('DELETE FROM opes.app_users WHERE id=$1', [userId]);
    });
    await app.close();
  });

  function put(key: string, value: string, lastModified = new Date()) {
    const bytes = Buffer.from(value);
    objects.set(key, {
      bytes,
      contentType: 'text/plain',
      etag: createHash('md5').update(bytes).digest('hex'),
      lastModified,
    });
  }
  function requireObject(key: string) {
    const value = objects.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  function metadata(key: string, value: ObjectValue): BucketObject {
    return {
      key,
      etag: value.etag,
      sizeBytes: value.bytes.length,
      lastModified: value.lastModified,
      contentType: value.contentType,
    };
  }
  async function documentCount() {
    return (
      await database.withOrganizationScope(organizationId, (sql) =>
        sql.query<{ count: string }>(
          'SELECT count(*)::text FROM opes.evidence_documents WHERE organization_id=$1',
          [organizationId],
        ),
      )
    ).rows[0].count;
  }
});

interface ObjectValue {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: Date;
}
