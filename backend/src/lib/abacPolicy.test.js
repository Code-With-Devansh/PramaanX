// Pure-logic tests for the ABAC overlay merge (node:test — no DB needed for the
// merge helpers). Run: DATABASE_URL=postgres://x node --test src/lib/abacPolicy.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, mergePolicy, POLICY_KEYS } from "./abacPolicy.js";

test("no override yields the defaults verbatim (identity)", () => {
  const merged = mergePolicy(DEFAULT_POLICY, null);
  assert.deepEqual(merged.clearanceRank, DEFAULT_POLICY.clearanceRank);
  assert.deepEqual(merged.permissionsByRole, DEFAULT_POLICY.permissionsByRole);
  assert.deepEqual(merged.elevatedCaseRoles, DEFAULT_POLICY.elevatedCaseRoles);
  assert.deepEqual(merged.crossJurisdictionRoles, DEFAULT_POLICY.crossJurisdictionRoles);
  assert.deepEqual(merged.permissionAliases, DEFAULT_POLICY.permissionAliases);
});

test("object-valued keys shallow-merge per entry", () => {
  const merged = mergePolicy(DEFAULT_POLICY, {
    permissionsByRole: { AUDITOR: ["audit:read", "governance:vote", "case:read"] },
    clearanceRank: { TOPSECRET: 4 },
  });
  // overridden entry replaced
  assert.deepEqual(merged.permissionsByRole.AUDITOR, ["audit:read", "governance:vote", "case:read"]);
  // untouched entries preserved
  assert.deepEqual(merged.permissionsByRole.SYSTEM_ADMIN, ["*"]);
  // clearanceRank extended, base kept
  assert.equal(merged.clearanceRank.TOPSECRET, 4);
  assert.equal(merged.clearanceRank.SECRET, 3);
});

test("elevatedCaseRoles replaces wholesale when present", () => {
  const merged = mergePolicy(DEFAULT_POLICY, { elevatedCaseRoles: ["SYSTEM_ADMIN"] });
  assert.deepEqual(merged.elevatedCaseRoles, ["SYSTEM_ADMIN"]);
});

test("crossJurisdictionRoles replaces wholesale when present", () => {
  const merged = mergePolicy(DEFAULT_POLICY, { crossJurisdictionRoles: ["SYSTEM_ADMIN", "ORG_ADMIN"] });
  assert.deepEqual(merged.crossJurisdictionRoles, ["SYSTEM_ADMIN", "ORG_ADMIN"]);
});

test("POLICY_KEYS is exactly the five overlay keys", () => {
  assert.deepEqual([...POLICY_KEYS].sort(), [
    "clearanceRank",
    "crossJurisdictionRoles",
    "elevatedCaseRoles",
    "permissionAliases",
    "permissionsByRole",
  ]);
});
