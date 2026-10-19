export function parseBearerToken(
  value: string | undefined,
): string | undefined {
  const prefix = 'Bearer ';
  if (value === undefined || !value.startsWith(prefix)) {
    return undefined;
  }

  const token = value.slice(prefix.length).trim();
  return token === '' ? undefined : token;
}
