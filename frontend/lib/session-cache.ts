const tenantPrefix = "opes:tenant:";

export const sessionStorageKeys = {
  token: "opes:session-token",
  selectedOrganizationId: "opes:selected-organization-id",
} as const;

export function clearTenantCache(storage: Storage, organizationId?: string) {
  const prefix = organizationId
    ? `${tenantPrefix}${organizationId}:`
    : tenantPrefix;

  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      storage.removeItem(key);
    }
  }
}

export function tenantCacheKey(organizationId: string, key: string) {
  return `${tenantPrefix}${organizationId}:${key}`;
}
