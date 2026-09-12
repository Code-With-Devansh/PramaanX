// Pure quorum arithmetic for admin pools (GOVERNANCE.md §5, k-of-m). No db import
// on purpose — this is the one governance module that is unit-testable in
// isolation with node:test.
//
// The default threshold is a strict majority: k = floor(m/2) + 1. A pool MAY set
// a custom k, but only within [2, m]: k < 2 would let a single (possibly
// compromised) admin act alone — the exact thing principle 1 forbids — and m < 2
// is not a pool at all. These floors are enforced here AND by a CHECK constraint
// on admin_pools as a backstop.

export const MIN_K = 2;
export const MIN_M = 2;

// Strict-majority threshold for a pool of size m (m=2⇒2, 3⇒2, 4⇒3, 5⇒3, 6⇒4 …).
export function defaultK(m) {
  return Math.floor(m / 2) + 1;
}

// Throw-free predicate — true iff (k, m) is a legal quorum.
export function isValidThreshold(k, m) {
  return (
    Number.isInteger(k) &&
    Number.isInteger(m) &&
    m >= MIN_M &&
    k >= MIN_K &&
    k <= m
  );
}

// Assert (k, m) is a legal quorum and return the normalized { k, m }. When k is
// omitted (undefined/null) the majority default is applied. Throws a plain Error
// on violation — callers (services) map it to badRequest(...). defaultK(m) is
// always within [2, m] for m ≥ 2, so "k === defaultK(m) OR custom k in [2, m]"
// collapses to the single range check below.
export function validateThreshold(k, m) {
  if (!Number.isInteger(m) || m < MIN_M) {
    throw new Error(`pool size m must be an integer >= ${MIN_M}`);
  }
  const effectiveK = k === undefined || k === null ? defaultK(m) : k;
  if (!Number.isInteger(effectiveK) || effectiveK < MIN_K || effectiveK > m) {
    throw new Error(`quorum k must be an integer in [${MIN_K}, ${m}]`);
  }
  return { k: effectiveK, m };
}
