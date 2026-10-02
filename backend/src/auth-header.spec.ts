import { parseBearerToken } from './auth-header';

describe('parseBearerToken', () => {
  it('extracts a bearer token', () => {
    expect(parseBearerToken('Bearer token-1')).toBe('token-1');
  });

  it('rejects missing or empty bearer tokens', () => {
    expect(parseBearerToken(undefined)).toBeUndefined();
    expect(parseBearerToken('token-1')).toBeUndefined();
    expect(parseBearerToken('Bearer   ')).toBeUndefined();
  });
});
