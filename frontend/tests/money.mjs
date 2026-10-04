import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAtomic } from "../.next-test/money.js";

test("formats atomic USDC without float math", () => {
  assert.equal(formatAtomic("123456789", 6), "123.456789");
  assert.equal(formatAtomic("1000000", 6), "1.0");
  assert.equal(formatAtomic("1", 6), "0.000001");
});
