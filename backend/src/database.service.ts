import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadRuntimeConfig } from './runtime.config';
import { assertTenantContext, TenantContext } from './tenant-context';

export interface TenantDatabase {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

interface DatabasePool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool?: DatabasePool;
  private readonly databaseUrl = loadRuntimeConfig().databaseUrl;

  async withDatabase<T>(
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async withTransaction<T>(
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async withTenant<T>(
    context: TenantContext,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    assertTenantContext(context);

    return this.withOrganizationScope(context.organizationId, work);
  }

  async withOrganizationScope<T>(
    organizationId: string,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    if (organizationId.trim() === '') {
      throw new Error('organizationId is required');
    }

    const client = await this.getPool().connect();

    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('opes.organization_id', $1, true)",
        [organizationId],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private getPool(): DatabasePool {
    if (this.pool === undefined) {
      if (this.databaseUrl === undefined) {
        throw new Error('DATABASE_URL is required for database access');
      }

      this.pool = new Pool({ connectionString: this.databaseUrl });
    }

    return this.pool;
  }
}
