import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from './connector-credentials';

const key = 'ab'.repeat(32);

it('encrypts credentials with tenant-bound authenticated encryption', () => {
  const encrypted = encryptConnectorCredentials(
    'tenant-a',
    'connector-a',
    { apiKey: 'secret' },
    key,
  );
  expect(encrypted).not.toContain('secret');
  expect(
    decryptConnectorCredentials('tenant-a', 'connector-a', encrypted, key),
  ).toEqual({ apiKey: 'secret' });
  expect(() =>
    decryptConnectorCredentials('tenant-a', 'connector-b', encrypted, key),
  ).toThrow();
});
