// Registry-shape tests for the six newly-implemented sudo actions (node:test).
// Run: DATABASE_URL=postgres://x node --test src/governance/sudoActions.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUDO_ACTIONS, getAction, resolveCrossTier } from "./sudoActions.js";

const ok = (fn) => assert.doesNotThrow(fn);
const bad = (fn) => assert.throws(fn);

test("APPOINT/REMOVE_SYSTEM_ADMIN: govern the org-less SYSTEM_ADMIN pool", () => {
  for (const t of ["APPOINT_SYSTEM_ADMIN", "REMOVE_SYSTEM_ADMIN"]) {
    const a = SUDO_ACTIONS[t];
    assert.equal(a.supported, true);
    assert.deepEqual(a.targetPool({}), { poolType: "SYSTEM_ADMIN", org: null });
    assert.deepEqual(resolveCrossTier(a, {}), { poolType: "SECURITY_ADMIN", org: null });
    ok(() => a.validatePayload({ userId: "u" }));
    bad(() => a.validatePayload({}));
  }
});

test("ONBOARD_ORG: requires org + non-empty members, SYSTEM_ADMIN governs", () => {
  const a = SUDO_ACTIONS.ONBOARD_ORG;
  assert.deepEqual(a.targetPool({}), { poolType: "SYSTEM_ADMIN", org: null });
  assert.deepEqual(resolveCrossTier(a, {}), { poolType: "SECURITY_ADMIN", org: null });
  ok(() => a.validatePayload({ org: "acme", members: ["a", "b"] }));
  bad(() => a.validatePayload({ org: "acme", members: [] }));
  bad(() => a.validatePayload({ members: ["a"] }));
});

test("CHANGE_ABAC_POLICY: inverted quorum, policy shape guard", () => {
  const a = SUDO_ACTIONS.CHANGE_ABAC_POLICY;
  assert.deepEqual(a.targetPool({}), { poolType: "SECURITY_ADMIN", org: null });
  assert.deepEqual(resolveCrossTier(a, {}), { poolType: "SYSTEM_ADMIN", org: null });
  assert.equal(a.crossTierQuorum, true);
  ok(() => a.validatePayload({ policy: { permissionsByRole: { AUDITOR: ["audit:read"] } } }));
  bad(() => a.validatePayload({ policy: {} }));
  bad(() => a.validatePayload({ policy: { bogusKey: 1 } }));
  bad(() => a.validatePayload({ policy: { elevatedCaseRoles: "not-an-array" } }));
  bad(() => a.validatePayload({}));
});

test("POOL_REINSTATEMENT: payload-dependent cross-tier + SYSTEM_ADMIN rejection", () => {
  const a = SUDO_ACTIONS.POOL_REINSTATEMENT;
  assert.equal(a.auditorQuorum, true);
  assert.ok(a.delayHours > 0);
  assert.deepEqual(a.targetPool({}), { poolType: "SYSTEM_ADMIN", org: null });
  // ORG_ADMIN reinstatement → Security co-sign required
  assert.deepEqual(resolveCrossTier(a, { poolType: "ORG_ADMIN" }), {
    poolType: "SECURITY_ADMIN",
    org: null,
  });
  // SECURITY_ADMIN reinstatement → no cross-tier (that pool may be the casualty)
  assert.equal(resolveCrossTier(a, { poolType: "SECURITY_ADMIN" }), null);
  ok(() => a.validatePayload({ poolType: "ORG_ADMIN", org: "acme", members: ["a", "b"] }));
  ok(() => a.validatePayload({ poolType: "SECURITY_ADMIN", members: ["a", "b"] }));
  bad(() => a.validatePayload({ poolType: "ORG_ADMIN", members: ["a"] })); // missing org
  bad(() => a.validatePayload({ poolType: "SYSTEM_ADMIN", members: ["a"] })); // → GENESIS_REPLACEMENT
});

test("GENESIS_REPLACEMENT stays unsupported (never a normal proposal)", () => {
  assert.equal(SUDO_ACTIONS.GENESIS_REPLACEMENT.supported, false);
});

test("resolveCrossTier returns null when the action has no cross-tier", () => {
  assert.equal(resolveCrossTier({ crossTier: undefined }, {}), null);
  assert.equal(resolveCrossTier({ crossTier: () => null }, {}), null);
});

test("getAction returns null for unknown enum entries", () => {
  assert.equal(getAction("NOPE"), null);
});
