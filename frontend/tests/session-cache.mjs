import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTenantCache, tenantCacheKey } from "../.next-test/session-cache.js";

class MemoryStorage {
  values = new Map();
  get length() {
    return this.values.size;
  }
  key(index) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, value);
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

test("clears only the selected tenant cache", () => {
  const storage = new MemoryStorage();
  storage.setItem(tenantCacheKey("org-a", "invoices"), "stale");
  storage.setItem(tenantCacheKey("org-b", "invoices"), "fresh");
  storage.setItem("opes:session-token", "token");

  clearTenantCache(storage, "org-a");

  assert.equal(storage.getItem(tenantCacheKey("org-a", "invoices")), null);
  assert.equal(storage.getItem(tenantCacheKey("org-b", "invoices")), "fresh");
  assert.equal(storage.getItem("opes:session-token"), "token");
});

test("logout clears every tenant cache entry", () => {
  const storage = new MemoryStorage();
  storage.setItem(tenantCacheKey("org-a", "invoices"), "stale");
  storage.setItem(tenantCacheKey("org-b", "ledger"), "stale");

  clearTenantCache(storage);

  assert.equal(storage.length, 0);
});
