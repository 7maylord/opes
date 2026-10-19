import { loadRuntimeConfig } from './runtime.config';

describe('loadRuntimeConfig', () => {
  it('uses safe local defaults outside production', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'test' })).toEqual({
      environment: 'test',
      port: 3000,
      allowedOrigins: ['http://localhost:3001'],
      databaseUrl: undefined,
    });
  });

  it('fails clearly for an invalid port', () => {
    expect(() => loadRuntimeConfig({ PORT: 'nope' })).toThrow(
      'PORT must be an integer from 1 to 65535',
    );
  });

  it('requires explicit origins in production', () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: 'production' })).toThrow(
      'OPES_ALLOWED_ORIGINS is required in production',
    );
  });

  it('validates database URLs when provided', () => {
    expect(() => loadRuntimeConfig({ DATABASE_URL: 'nope' })).toThrow(
      'DATABASE_URL must be a valid URL',
    );
  });
});
