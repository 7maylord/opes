import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadRuntimeConfig } from '../config/runtime.config';
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
  private readonly logger = new Logger(DatabaseService.name);
  private waiting = 0;
  private closing = false;
  private readonly databaseUrl = loadRuntimeConfig().databaseUrl;

  async withDatabase<T>(
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();

    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async withTransaction<T>(
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();
    let discard = false;

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async withTenant<T>(
    context: TenantContext,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    assertTenantContext(context);

    return this.withOrganizationScope(context.organizationId, work);
  }

  async withUserScope<T>(
    userId: string,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    if (userId.trim() === '') {
      throw new Error('userId is required');
    }

    const client = await this.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opes.user_id', $1, true)", [
        userId,
      ]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async withOrganizationScope<T>(
    organizationId: string,
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    if (organizationId.trim() === '') {
      throw new Error('organizationId is required');
    }

    const client = await this.connect();
    let discard = false;

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
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async withWorker<T>(
    work: (database: TenantDatabase) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();
    let discard = false;

    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('opes.worker', 'true', true)");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }

  private async connect(): Promise<PoolClient> {
    if (this.closing || this.waiting >= 100)
      throw new ServiceUnavailableException('Database is busy; retry shortly');
    this.waiting++;
    try {
      return await this.getPool().connect();
    } finally {
      this.waiting--;
    }
  }

  private getPool(): DatabasePool {
    if (this.pool === undefined) {
      if (this.databaseUrl === undefined) {
        throw new Error('DATABASE_URL is required for database access');
      }

      const pool = new Pool({
        connectionString: this.databaseUrl,
        max: 10,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 25_000,
        query_timeout: 30_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 60_000,
      });
      pool.on('error', () =>
        this.logger.error('Idle database connection lost; pool will reconnect'),
      );
      this.pool = pool;
    }

    return this.pool;
  }
}
