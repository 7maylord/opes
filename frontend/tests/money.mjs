import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAtomic, parseDecimalToAtomic } from "../.next-test/money.js";

test("formats atomic USDC without float math", () => {
  assert.equal(formatAtomic("123456789", 6), "123.456789");
  assert.equal(formatAtomic("1000000", 6), "1.0");
  assert.equal(formatAtomic("1", 6), "0.000001");
});

test("parses USDC without float math", () => {
  assert.equal(parseDecimalToAtomic("10", 6), "10000000");
  assert.equal(parseDecimalToAtomic("1.25", 6), "1250000");
  assert.throws(() => parseDecimalToAtomic("1.0000001", 6));
});
