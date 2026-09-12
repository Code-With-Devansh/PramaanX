import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_K,
  MIN_M,
  defaultK,
  isValidThreshold,
  validateThreshold,
} from "./poolMath.js";

// Pure quorum arithmetic (GOVERNANCE.md §5, k-of-m). Runner: `node --test`
// (mirrors the co-located src/ledger/*.test.js convention). k = floor(m/2)+1 by
// default, with a hard floor k>=2 and m>=2 so no single admin can ever act alone.

test("defaultK is a strict majority (m=2⇒2, 3⇒2, 4⇒3, 5⇒3, 6⇒4)", () => {
  assert.equal(defaultK(2), 2);
  assert.equal(defaultK(3), 2);
  assert.equal(defaultK(4), 3);
  assert.equal(defaultK(5), 3);
  assert.equal(defaultK(6), 4);
  assert.equal(defaultK(7), 4);
});

test("floors are the documented constants", () => {
  assert.equal(MIN_K, 2);
  assert.equal(MIN_M, 2);
});

test("validateThreshold defaults k to the majority when k is omitted", () => {
  assert.deepEqual(validateThreshold(undefined, 2), { k: 2, m: 2 });
  assert.deepEqual(validateThreshold(null, 3), { k: 2, m: 3 });
  assert.deepEqual(validateThreshold(undefined, 4), { k: 3, m: 4 });
  assert.deepEqual(validateThreshold(null, 5), { k: 3, m: 5 });
});

test("validateThreshold accepts a valid custom k within [2, m]", () => {
  assert.deepEqual(validateThreshold(2, 2), { k: 2, m: 2 });
  assert.deepEqual(validateThreshold(3, 4), { k: 3, m: 4 });
  assert.deepEqual(validateThreshold(4, 4), { k: 4, m: 4 }); // unanimous is allowed
  assert.deepEqual(validateThreshold(5, 9), { k: 5, m: 9 });
});

test("validateThreshold rejects m < 2 (not a pool)", () => {
  assert.throws(() => validateThreshold(undefined, 1), /m must be an integer >= 2/);
  assert.throws(() => validateThreshold(1, 1), /m must be an integer >= 2/);
  assert.throws(() => validateThreshold(undefined, 0), /m must be an integer >= 2/);
});

test("validateThreshold rejects k below the hard floor of 2", () => {
  // k=1 would let a single (possibly compromised) admin act alone — forbidden.
  assert.throws(() => validateThreshold(1, 3), /k must be an integer in \[2, 3\]/);
  assert.throws(() => validateThreshold(0, 5), /k must be an integer in \[2, 5\]/);
});

test("validateThreshold rejects k greater than m", () => {
  assert.throws(() => validateThreshold(4, 3), /k must be an integer in \[2, 3\]/);
  assert.throws(() => validateThreshold(3, 2), /k must be an integer in \[2, 2\]/);
});

test("validateThreshold rejects non-integer k or m", () => {
  assert.throws(() => validateThreshold(2.5, 4), /k must be an integer/);
  assert.throws(() => validateThreshold(2, 4.5), /m must be an integer/);
});

test("isValidThreshold is a throw-free mirror of the same rules", () => {
  // Valid.
  assert.equal(isValidThreshold(2, 2), true);
  assert.equal(isValidThreshold(2, 3), true);
  assert.equal(isValidThreshold(3, 4), true);
  assert.equal(isValidThreshold(9, 9), true);
  // Invalid: k too low, k>m, m too low, non-integers.
  assert.equal(isValidThreshold(1, 3), false);
  assert.equal(isValidThreshold(4, 3), false);
  assert.equal(isValidThreshold(2, 1), false);
  assert.equal(isValidThreshold(2.5, 4), false);
  assert.equal(isValidThreshold(2, Number.NaN), false);
});
