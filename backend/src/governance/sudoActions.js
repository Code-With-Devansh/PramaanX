// Declarative registry of privileged ("sudo") actions (GOVERNANCE.md §5). Each
// entry declares:
//   - targetPool(payload) → { poolType, org }: whose k-of-m quorum governs it,
//   - crossTier: the pool type that MUST additionally co-sign (a pool can never
//     approve a change to itself purely from within — principle of separation),
//   - delayHours: execution delay (0 for the foundational actions; the Tier-2
//     reinstatement window is deferred), and
//   - validatePayload(payload): an action-specific shape guard.
//
// The proposals service reads THIS — never the client — to decide who may propose,
// what constitutes quorum, and how to execute. Adding or altering an action is a
// single-place change.
//
// Extended entry shape (all optional except targetPool/validatePayload):
//   - crossTier: poolType | ((payload) => poolType | null) — the co-signing pool.
//       A function lets it depend on payload (POOL_REINSTATEMENT: no Security
//       co-sign when the Security pool is itself the casualty).
//   - crossTierQuorum: boolean — if true the cross-tier pool must reach its OWN k
//       (k-of-N acknowledgement, CHANGE_ABAC_POLICY); else ≥1 co-sign suffices.
//   - auditorQuorum: boolean — if true, also require k-of-P AUDITOR_VOTE from
//       active AUDITOR-role users (Tier-2 POOL_REINSTATEMENT).

import config from "../config/index.js";
import { POLICY_KEYS } from "../lib/abacPolicy.js";
import { orgRepository } from "../repositories/reference.repository.js";
import userRepository from "../repositories/user.repository.js";
import { badRequest, notFound } from "../lib/errors.js";
import { role as roleEnum } from "../db/schema/index.js";

// Roles REMOVE_ORG_ADMIN may demote a user to. Any role except the two admin
// tiers — this action is a demotion out of ORG_ADMIN, not a lateral move into
// another admin tier (that's what APPOINT_/REMOVE_SYSTEM_ADMIN and a fresh
// APPOINT_ORG_ADMIN proposal are for).
export const DEMOTABLE_ROLES = Object.freeze(
  roleEnum.enumValues.filter((r) => r !== "ORG_ADMIN" && r !== "SYSTEM_ADMIN"),
);

function requireFields(payload, fields) {
  for (const f of fields) {
    const v = payload?.[f];
    if (v === undefined || v === null || v === "") {
      throw new Error(`payload.${f} is required`);
    }
  }
}

// Shape guard for a CHANGE_ABAC_POLICY override document. Only the known
// top-level keys are allowed (unknown keys ⇒ reject, not silently ignore), and
// each must carry the expected container type. The VALUES are trusted structurally
// (they're merged verbatim) — this is a shape gate, not a semantic validator.
function validateAbacPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("payload.policy must be an object");
  }
  const keys = Object.keys(policy);
  if (keys.length === 0) throw new Error("payload.policy must not be empty");
  for (const k of keys) {
    if (!POLICY_KEYS.includes(k)) {
      throw new Error(`payload.policy has unknown key '${k}'`);
    }
  }
  const objectKeys = ["clearanceRank", "permissionAliases", "permissionsByRole"];
  for (const k of objectKeys) {
    if (policy[k] !== undefined && (typeof policy[k] !== "object" || Array.isArray(policy[k]))) {
      throw new Error(`payload.policy.${k} must be an object`);
    }
  }
  const arrayKeys = ["elevatedCaseRoles", "crossJurisdictionRoles"];
  for (const k of arrayKeys) {
    if (policy[k] !== undefined && !Array.isArray(policy[k])) {
      throw new Error(`payload.policy.${k} must be an array`);
    }
  }
}

// Shared DB-aware guard for ONBOARD_ORG: `payload.org` must already exist (it
// is created up front via the reference:manage /orgs endpoint — ONBOARD_ORG
// never creates or names an org itself, only stands up its ORG_ADMIN pool),
// and every proposed member must already be an active user tagged to that
// same org. Called from fileProposal at file time (fails fast for the
// proposer) AND from the ONBOARD_ORG execute helper — file time is a courtesy
// check against state *at submission*; nothing stops the org or a member's
// orgId changing during the quorum/delay window before execute actually runs,
// so execute-time re-validation is the real enforcement point.
export async function assertOnboardRoster(payload) {
  const org = await orgRepository.findById(payload.org);
  if (!org) throw notFound(`org '${payload.org}' does not exist`);

  const memberIds = [...new Set(payload.members)];
  for (const uid of memberIds) {
    const u = await userRepository.findById(uid);
    if (!u || u.status !== "ACTIVE") {
      throw badRequest(`member ${uid} is not an active user`);
    }
    if (u.orgId !== payload.org) {
      throw badRequest(`member ${uid} does not belong to org '${payload.org}'`);
    }
  }
}

export const SUDO_ACTIONS = Object.freeze({
  // Appoint a user into an org's ORG_ADMIN pool. Quorum: that org's ORG_ADMIN
  // pool; co-sign: a Security Admin (cross-tier).
  APPOINT_ORG_ADMIN: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: (p) => ({ poolType: "ORG_ADMIN", org: p.org }),
    validatePayload: (p) => requireFields(p, ["org", "userId"]),
  },

  // Remove a user from an org's ORG_ADMIN pool. Same quorum + co-sign as appoint.
  // Removal also demotes the user's `role` (see proposals.service#executeProposal)
  // away from ORG_ADMIN, so the caller must say what they demote to — there's no
  // implicit "restore prior role", since role is flipped at appoint time, not
  // snapshotted (see APPOINT_ORG_ADMIN).
  REMOVE_ORG_ADMIN: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: (p) => ({ poolType: "ORG_ADMIN", org: p.org }),
    validatePayload: (p) => {
      requireFields(p, ["org", "userId", "demotedRole"]);
      if (!DEMOTABLE_ROLES.includes(p.demotedRole)) {
        throw new Error(
          `payload.demotedRole must be one of: ${DEMOTABLE_ROLES.join(", ")}`,
        );
      }
    },
  },

  // Change a pool's quorum threshold k. Quorum: the affected pool; co-sign: a
  // Security Admin (cross-tier) — a pool may never re-threshold itself alone.
  CHANGE_POOL_THRESHOLD: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: (p) => ({ poolType: p.poolType, org: p.org ?? null }),
    validatePayload: (p) => {
      requireFields(p, ["poolType", "k"]);
      if (!Number.isInteger(p.k)) throw new Error("payload.k must be an integer");
    },
  },

  // ── System-Admin tier (governing pool = the SYSTEM_ADMIN pool, org null;
  //    cross-tier co-sign = a Security Admin) ──────────────────────────────────
  // Appoint a user into the top-tier SYSTEM_ADMIN pool. Mirrors APPOINT_ORG_ADMIN
  // one tier up.
  APPOINT_SYSTEM_ADMIN: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: () => ({ poolType: "SYSTEM_ADMIN", org: null }),
    validatePayload: (p) => requireFields(p, ["userId"]),
  },

  // Remove a user from the SYSTEM_ADMIN pool. Last-admin/quorum-floor removal is
  // blocked in the execute branch; total top-tier loss is the GENESIS_REPLACEMENT
  // recovery path, not this action.
  REMOVE_SYSTEM_ADMIN: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: () => ({ poolType: "SYSTEM_ADMIN", org: null }),
    validatePayload: (p) => requireFields(p, ["userId"]),
  },

  // Stand up a new org's ORG_ADMIN pool. Governed by the SYSTEM_ADMIN pool (only
  // the top tier onboards orgs); Security Admin co-signs. The new pool + its
  // members are created in the execute branch (it does not exist at file time).
  ONBOARD_ORG: {
    supported: true,
    crossTier: "SECURITY_ADMIN",
    delayHours: 0,
    targetPool: () => ({ poolType: "SYSTEM_ADMIN", org: null }),
    validatePayload: (p) => {
      requireFields(p, ["org", "members"]);
      if (!Array.isArray(p.members) || p.members.length < 1) {
        throw new Error("payload.members must be a non-empty array");
      }
      if (p.k !== undefined && p.k !== null && !Number.isInteger(p.k)) {
        throw new Error("payload.k must be an integer");
      }
    },
    // DB-aware, run once at file time in addition to execute time — see
    // assertOnboardRoster above.
    validateAtFileTime: (p) => assertOnboardRoster(p),
  },

  // ── Inverted quorum: Security Admin is PRIMARY, System Admins acknowledge
  //    (GOVERNANCE.md §9.2). Governing pool = SECURITY_ADMIN; cross-tier =
  //    SYSTEM_ADMIN and must reach its OWN k (k-of-N acknowledgement). ──────────
  CHANGE_ABAC_POLICY: {
    supported: true,
    crossTier: "SYSTEM_ADMIN",
    crossTierQuorum: true,
    delayHours: 0,
    targetPool: () => ({ poolType: "SECURITY_ADMIN", org: null }),
    validatePayload: (p) => {
      requireFields(p, ["policy"]);
      validateAbacPolicy(p.policy);
    },
  },

  // ── Tier-2 recovery: reinstate a pool that fell below its own quorum. Governed
  //    by the SYSTEM_ADMIN pool (escalated one level up) + k-of-P Auditor votes.
  //    Cross-tier Security co-sign only when the AFFECTED pool is ORG_ADMIN — when
  //    reinstating the SECURITY_ADMIN pool that pool may itself be the casualty,
  //    so its co-sign cannot be required (System + Auditor quorums carry it). ────
  POOL_REINSTATEMENT: {
    supported: true,
    crossTier: (p) => (p.poolType === "ORG_ADMIN" ? "SECURITY_ADMIN" : null),
    auditorQuorum: true,
    delayHours: config.governance.defaultDelayHours,
    targetPool: () => ({ poolType: "SYSTEM_ADMIN", org: null }),
    validatePayload: (p) => {
      requireFields(p, ["poolType", "members"]);
      if (p.poolType === "SYSTEM_ADMIN") {
        throw new Error("SYSTEM_ADMIN reinstatement uses GENESIS_REPLACEMENT");
      }
      if (!["ORG_ADMIN", "SECURITY_ADMIN"].includes(p.poolType)) {
        throw new Error("payload.poolType must be ORG_ADMIN or SECURITY_ADMIN");
      }
      if (p.poolType === "ORG_ADMIN") requireFields(p, ["org"]);
      if (!Array.isArray(p.members) || p.members.length < 1) {
        throw new Error("payload.members must be a non-empty array");
      }
      if (p.k !== undefined && p.k !== null && !Number.isInteger(p.k)) {
        throw new Error("payload.k must be an integer");
      }
    },
  },

  // ── Tier-3: entire top tier locked out. NOT a proposal (no healthy pool remains
  //    to vote) — handled by the share-authorized regenesis ceremony (bootstrap
  //    sibling). Kept unsupported so it can never be filed as a normal proposal. ─
  GENESIS_REPLACEMENT: { supported: false },
});

// Resolve the effective cross-tier pool spec for an action+payload, or null when
// the action has no cross-tier requirement (or the fn returned null). Both
// classifyApprover and executeProposal call this so they agree on the co-signer.
export function resolveCrossTier(action, payload) {
  const ct = action?.crossTier;
  const poolType = typeof ct === "function" ? ct(payload ?? {}) : ct;
  if (!poolType) return null;
  return { poolType, org: null };
}

// Registry lookup; null for an unknown actionType (the zod enum already rejects
// values outside sudo_action_type, so null here means "known enum, no entry").
export function getAction(actionType) {
  return SUDO_ACTIONS[actionType] ?? null;
}
