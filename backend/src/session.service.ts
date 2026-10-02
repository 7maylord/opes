import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';

const defaultTtlMs = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

interface SessionUserRow {
  id: string;
  email: string;
  display_name: string;
}

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService) {}

  async createSession(
    userId: string,
    ttlMs: number = defaultTtlMs,
  ): Promise<string> {
    if (userId.trim() === '') {
      throw new Error('userId is required');
    }

    return this.database.withDatabase((database) =>
      this.createSessionRecord(database, userId, ttlMs),
    );
  }

  async createSessionRecord(
    database: TenantDatabase,
    userId: string,
    ttlMs: number = defaultTtlMs,
  ): Promise<string> {
    if (userId.trim() === '') {
      throw new Error('userId is required');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    await database.query(
      `
        INSERT INTO opes.user_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
      `,
      [userId, tokenHash, expiresAt],
    );

    return token;
  }

  async resolveUser(token: string): Promise<SessionUser | null> {
    if (token.trim() === '') {
      return null;
    }

    const tokenHash = hashSessionToken(token);
    const result = await this.database.withDatabase((database) =>
      database.query<SessionUserRow>(
        `
          UPDATE opes.user_sessions AS session
             SET last_used_at = now()
            FROM opes.app_users AS app_user
           WHERE session.user_id = app_user.id
             AND session.token_hash = $1
             AND session.status = 'ACTIVE'
             AND session.expires_at > now()
          RETURNING app_user.id, app_user.email, app_user.display_name
        `,
        [tokenHash],
      ),
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
    };
  }
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
