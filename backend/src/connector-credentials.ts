import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptConnectorCredentials(
  organizationId: string,
  connectorId: string,
  credentials: unknown,
  key = process.env.OPES_CONNECTOR_ENCRYPTION_KEY,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseKey(key), iv);
  cipher.setAAD(Buffer.from(`${organizationId}:${connectorId}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}

export function decryptConnectorCredentials<T>(
  organizationId: string,
  connectorId: string,
  encrypted: string,
  key = process.env.OPES_CONNECTOR_ENCRYPTION_KEY,
): T {
  const [version, iv, tag, ciphertext, extra] = encrypted.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) {
    throw new Error('Connector credentials are invalid');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    parseKey(key),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(`${organizationId}:${connectorId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  ) as T;
}

function parseKey(value: string | undefined): Buffer {
  if (value === undefined || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('OPES_CONNECTOR_ENCRYPTION_KEY must be 64 hex characters');
  }
  return Buffer.from(value, 'hex');
}
