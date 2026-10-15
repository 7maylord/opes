import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { isEmbeddedWalletLinkedAccount, PrivyClient } from '@privy-io/node';
import { DatabaseService, TenantDatabase } from './database.service';
import { SessionService, SessionUser } from './session.service';

export interface AuthSessionResult {
  user: SessionUser;
  sessionToken: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  privy_user_id: string | null;
  owner_wallet_address: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  async exchangePrivyToken(accessToken: string): Promise<AuthSessionResult> {
    const appId = process.env.PRIVY_APP_ID?.trim();
    const appSecret = process.env.PRIVY_APP_SECRET?.trim();
    if (!appId || !appSecret) {
      this.logger.error(
        'Privy session exchange rejected: server credentials are missing',
      );
      throw new ServiceUnavailableException(
        'Privy authentication is not configured',
      );
    }

    const privy = new PrivyClient({ appId, appSecret });
    let privyUserId: string;
    let email: string | undefined;
    let ownerWalletAddress: string | undefined;
    try {
      this.logger.log('Privy session exchange started');
      const claims = await privy.utils().auth().verifyAccessToken(accessToken);
      privyUserId = claims.user_id;
      const identity = await privy.users()._get(privyUserId);
      email = identity.linked_accounts.find(
        (account) => account.type === 'email',
      )?.address;
      const embeddedEthereumWallet = identity.linked_accounts
        .filter(isEmbeddedWalletLinkedAccount)
        .find((account) => account.chain_type === 'ethereum');
      if (typeof embeddedEthereumWallet?.address === 'string') {
        ownerWalletAddress = embeddedEthereumWallet.address;
      }
      this.logger.log(
        `Privy identity verified: email=${Boolean(email)} embeddedEthereumWallet=${Boolean(ownerWalletAddress)}`,
      );
    } catch (reason) {
      this.logger.warn(
        `Privy token verification failed: ${reason instanceof Error ? reason.message : 'unknown error'}`,
      );
      throw new UnauthorizedException(
        'Privy access token is invalid or expired',
      );
    }
    if (!email) {
      this.logger.warn(
        'Privy session exchange rejected: verified email is missing',
      );
      throw new UnauthorizedException('A verified Privy email is required');
    }
    if (
      !ownerWalletAddress ||
      !/^0x[0-9a-fA-F]{40}$/.test(ownerWalletAddress)
    ) {
      this.logger.warn(
        'Privy session exchange rejected: embedded Ethereum wallet is missing',
      );
      throw new UnauthorizedException(
        'A Privy embedded Ethereum owner wallet is required',
      );
    }

    return this.database.withTransaction(async (database) => {
      const user = await linkPrivyUser(
        database,
        privyUserId,
        email,
        ownerWalletAddress,
      );
      const result = {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          ownerWalletAddress: user.owner_wallet_address,
        },
        sessionToken: await this.sessions.createSessionRecord(
          database,
          user.id,
        ),
      };
      this.logger.log(`Privy session exchange completed for user ${user.id}`);
      return result;
    });
  }
}

export async function linkPrivyUser(
  database: TenantDatabase,
  privyUserId: string,
  rawEmail: string,
  rawOwnerWalletAddress: string,
): Promise<UserRow> {
  const email = rawEmail.trim().toLowerCase();
  const ownerWalletAddress = rawOwnerWalletAddress.trim().toLowerCase();
  if (
    !privyUserId.trim() ||
    !email ||
    !/^0x[0-9a-f]{40}$/.test(ownerWalletAddress)
  ) {
    throw new UnauthorizedException('Privy identity is incomplete');
  }

  const existing = await database.query<UserRow>(
    `
      SELECT id, email, display_name, privy_user_id, owner_wallet_address
        FROM opes.app_users
       WHERE privy_user_id = $1
          OR email_normalized = $2
          OR lower(owner_wallet_address) = $3
       FOR UPDATE
    `,
    [privyUserId, email, ownerWalletAddress],
  );
  const subjectUser = existing.rows.find(
    (row) => row.privy_user_id === privyUserId,
  );
  const emailUser = existing.rows.find(
    (row) => row.email.toLowerCase() === email,
  );
  if (subjectUser && emailUser && subjectUser.id !== emailUser.id) {
    throw new ConflictException(
      'Privy identity conflicts with an existing email',
    );
  }
  const user = subjectUser ?? emailUser;
  const walletUser = existing.rows.find(
    (row) => row.owner_wallet_address?.toLowerCase() === ownerWalletAddress,
  );
  if (walletUser && walletUser.id !== user?.id) {
    throw new ConflictException(
      'Owner wallet is already linked to another user',
    );
  }
  if (user?.privy_user_id && user.privy_user_id !== privyUserId) {
    throw new ConflictException(
      'Email is already linked to another Privy user',
    );
  }
  if (
    user?.owner_wallet_address &&
    user.owner_wallet_address.toLowerCase() !== ownerWalletAddress
  ) {
    throw new ConflictException(
      'Privy owner wallet does not match its binding',
    );
  }

  const displayName = email.split('@')[0] || email;
  const result = user
    ? await database.query<UserRow>(
        `
          UPDATE opes.app_users
             SET email = $2,
                 privy_user_id = $3,
                 owner_wallet_address = $4,
                 privy_verified_at = now(),
                 owner_wallet_verified_at = now(),
                 updated_at = now()
           WHERE id = $1
          RETURNING id, email, display_name, privy_user_id, owner_wallet_address
        `,
        [user.id, email, privyUserId, ownerWalletAddress],
      )
    : await database.query<UserRow>(
        `
          INSERT INTO opes.app_users (
            email, display_name, privy_user_id, privy_verified_at,
            owner_wallet_address, owner_wallet_verified_at
          )
          VALUES ($1, $2, $3, now(), $4, now())
          RETURNING id, email, display_name, privy_user_id, owner_wallet_address
        `,
        [email, displayName, privyUserId, ownerWalletAddress],
      );
  const linked = result.rows[0];
  if (!linked) throw new Error('Failed to link Privy user');
  return linked;
}
