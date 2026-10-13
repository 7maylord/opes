import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('opes_schema_migrations'))");
  const directory = path.resolve('migrations');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const version = path.basename(file, '.sql');
    const exists = await client.query("SELECT to_regclass('opes.schema_migrations') IS NOT NULL AS exists");
    if (exists.rows[0].exists) {
      const applied = await client.query('SELECT 1 FROM opes.schema_migrations WHERE version = $1', [version]);
      if (applied.rowCount) continue;
    }

    await client.query(await fs.readFile(path.join(directory, file), 'utf8'));
    const recorded = await client.query('SELECT 1 FROM opes.schema_migrations WHERE version = $1', [version]);
    if (!recorded.rowCount) throw new Error(`${file} did not record its schema_migrations version`);
    process.stdout.write(`applied ${version}\n`);
  }

  const runtimeRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'opes_runtime'");
  if (runtimeRole.rowCount) {
    const databaseGrant = await client.query(
      "SELECT format('GRANT CONNECT ON DATABASE %I TO opes_runtime', current_database()) AS sql",
    );
    await client.query(databaseGrant.rows[0].sql);
    await client.query(`
      GRANT USAGE ON SCHEMA opes TO opes_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA opes TO opes_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA opes TO opes_runtime;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opes TO opes_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA opes GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opes_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA opes GRANT USAGE, SELECT ON SEQUENCES TO opes_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA opes GRANT EXECUTE ON FUNCTIONS TO opes_runtime;
    `);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('opes_schema_migrations'))").catch(() => undefined);
  await client.end();
}
