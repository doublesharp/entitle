import test from "node:test";
import assert from "node:assert/strict";
import { equal, hash, random, seal, unseal, csrf } from "../src/crypto.ts";

test("credential comparison rejects non-ASCII strings with matching character counts without throwing", () => {
  const expected = "a".repeat(43);
  assert.equal(equal("é".repeat(43), expected), false);
  assert.equal(equal(expected, expected), true);
  assert.equal(equal("b".repeat(43), expected), false);
  assert.equal(equal("short", expected), false);
});
test("random credentials are independent, hashed and bound to their encrypted payload and session", () => {
  const first = random(),
    second = random();
  assert.notEqual(first, second);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.equal(hash(first).length, 64);
  assert.notEqual(hash(first), hash(second));
  const secret = "ab".repeat(32),
    other = "cd".repeat(32);
  const value = { key: first, description: "License ✓" };
  const encrypted = seal(value, secret);
  assert.deepEqual(unseal(encrypted, secret), value);
  assert.ok(!encrypted.includes(first));
  assert.throws(() => unseal(encrypted, other));
  const tampered = Buffer.from(encrypted, "base64url");
  tampered[15] = tampered[15]! ^ 1;
  assert.throws(() => unseal(tampered.toString("base64url"), secret));
  assert.notEqual(csrf(first, secret), csrf(second, secret));
  assert.notEqual(csrf(first, secret), csrf(first, other));
});
