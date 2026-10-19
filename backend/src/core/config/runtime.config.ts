export type RuntimeEnvironment = 'development' | 'test' | 'production';

export interface RuntimeConfig {
  environment: RuntimeEnvironment;
  port: number;
  allowedOrigins: string[];
  databaseUrl?: string;
}

const environments = new Set<RuntimeEnvironment>([
  'development',
  'test',
  'production',
]);

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const environment = parseEnvironment(env.NODE_ENV);

  return {
    environment,
    port: parsePort(env.PORT),
    allowedOrigins: parseAllowedOrigins(env.OPES_ALLOWED_ORIGINS, environment),
    databaseUrl: parseOptionalUrl(env.DATABASE_URL, 'DATABASE_URL'),
  };
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === undefined || value === '') {
    return 'development';
  }

  if (environments.has(value as RuntimeEnvironment)) {
    return value as RuntimeEnvironment;
  }

  throw new Error(
    `NODE_ENV must be one of: ${Array.from(environments).join(', ')}`,
  );
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 3000;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return port;
}

function parseAllowedOrigins(
  value: string | undefined,
  environment: RuntimeEnvironment,
): string[] {
  if (value === undefined || value.trim() === '') {
    if (environment === 'production') {
      throw new Error('OPES_ALLOWED_ORIGINS is required in production');
    }

    return ['http://localhost:3001'];
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('OPES_ALLOWED_ORIGINS must include at least one origin');
  }

  for (const origin of origins) {
    try {
      new URL(origin);
    } catch {
      throw new Error(
        `OPES_ALLOWED_ORIGINS contains an invalid URL: ${origin}`,
      );
    }
  }

  return origins;
}

function parseOptionalUrl(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  return value;
}
