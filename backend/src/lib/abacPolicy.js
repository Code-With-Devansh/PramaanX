// ─────────────────────────────────────────────────────────────────────────────
// ABAC policy overlay resolver (CHANGE_ABAC_POLICY sudo action).
//
// The ACTIVE policy is DEFAULT_POLICY deep-merged with the highest-`version` row
// in abac_policies (see src/db/schema/abac.js). With no row, the merged result is
// DEFAULT_POLICY verbatim — so a system that never files a CHANGE_ABAC_POLICY
// proposal behaves exactly as it did before the overlay existed.
//
// DEFAULT_POLICY is the single source of truth for the baseline that authorize.js
// and user.mapper.js used to hardcode; both now consume the merged policy here.
//
// Caching: one in-module cache (`cached`), always readable synchronously via
// getActivePolicySync() (for the sync DTO mapper toMe). getActivePolicy() is the
// async accessor the PDP (authorize.js) awaits — it refreshes the cache when
// older than TTL_MS, so an enforcement decision is never more than ~15s stale.
// invalidatePolicyCache() forces an immediate reload after a policy change
// commits. Assumes a single API process; staleness is bounded by TTL either way.
// ─────────────────────────────────────────────────────────────────────────────

import { desc, max } from "drizzle-orm";
import { db } from "../db/index.js";
import { abacPolicies } from "../db/schema/index.js";

// Baseline policy — moved here verbatim from authorize.js / user.mapper.js.
// elevatedCaseRoles is a plain array here (JSON-friendly); authorize.js wraps it
// in a Set at read time.
export const DEFAULT_POLICY = Object.freeze({
  clearanceRank: {
    PUBLIC: 0,
    RESTRICTED: 1,
    CONFIDENTIAL: 2,
    SECRET: 3,
  },
  elevatedCaseRoles: ["SUPERVISOR", "ORG_ADMIN", "SYSTEM_ADMIN"],
  // Roles that bypass the jurisdiction boundary entirely — not just the
  // "elevated within your own jurisdiction" carve-out above, but the ability
  // to create cases in, and be granted standing case-access to, ANY
  // jurisdiction. Distinct from elevatedCaseRoles: the latter still gates on
  // user.jurisdictionId === caseRow.jurisdictionId (see authorize.js). This
  // list intentionally starts narrow (system-tier only, not ORG_ADMIN)
  // pending a governance decision to widen it via CHANGE_ABAC_POLICY.
  crossJurisdictionRoles: ["SYSTEM_ADMIN"],
  permissionAliases: {
    "user:read": ["user:read", "user:manage"],
    "user:manage": ["user:manage"],
    "case:list": ["case:list", "case:read", "cases:read", "case:manage", "cases:manage"],
    "case:read": ["case:read", "cases:read", "case:manage", "cases:manage"],
    "case:create": ["case:create", "case:manage", "cases:manage"],
    "case:update": ["case:update", "case:manage", "cases:manage"],
    "case:manage": ["case:manage", "cases:manage"],
    "case:legal-hold": ["case:legal-hold", "case:manage", "cases:manage"],
    "document:read": ["document:read", "documents:read", "document:manage", "documents:manage"],
    "document:list": ["document:list", "document:read", "documents:read", "document:manage", "documents:manage"],
    "document:download": ["document:download", "document:read", "documents:read", "document:manage", "documents:manage"],
    "document:create": ["document:create", "document:write", "documents:write"],
    "document:add-version": ["document:add-version", "document:write", "documents:write"],
    "document:restore": ["document:restore", "document:write", "documents:write"],
    "document:sign": ["document:sign", "documents:sign"],
    "document:seal": ["document:seal", "document:manage", "documents:manage"],
    "document:delete": ["document:delete", "document:manage", "documents:manage"],
    // POST /documents/:id/access. Broad at the RBAC layer (mirrors document:read
    // — anyone who could plausibly be a case creator/officer holds it), narrowed
    // per-request by documents.service#grantAccess: same-jurisdiction grants
    // need the actor to already have case access (elevated role / creator /
    // officer, same set canAccessCase trusts); cross-jurisdiction grants
    // additionally require the actor to be ORG_ADMIN or SYSTEM_ADMIN.
    "document:share": ["document:share", "document:manage", "documents:manage"],
    "governance:read": ["governance:read"],
    "governance:propose": ["governance:propose"],
    // AUDITOR only holds "governance:vote" (never a raw "governance:approve"),
    // but approve/object/execute are all gated on the "governance:approve"
    // action. Without this alias, auditors 403 here before ever reaching
    // proposals.service's classifyApprover — which is the actual, fail-closed
    // check for whether they're eligible on THIS proposal (AUDITOR_VOTE only
    // applies when action.auditorQuorum is set, e.g. POOL_REINSTATEMENT).
    "governance:approve": ["governance:approve", "governance:vote"],
    "governance:vote": ["governance:vote"],
    // orgs/jurisdictions reference-data CRUD (SYSTEM_ADMIN / SECURITY_ADMIN
    // only — see src/controllers/reference.controller.js). Deliberately a
    // plain RBAC gate, not a sudo/quorum action: unlike CHANGE_ABAC_POLICY,
    // this is reference-data maintenance, not a change to who holds power.
    "reference:read": ["reference:read", "reference:manage"],
    "reference:manage": ["reference:manage"],
  },
  permissionsByRole: {
    INVESTIGATING_OFFICER: ["case:read", "document:read", "document:write", "document:share"],
    SUPERVISOR: ["case:read", "case:manage", "document:read", "document:write", "document:share"],
    PROSECUTOR: ["case:read", "document:read", "document:sign"],
    JUDGE: ["case:read", "document:read", "document:sign"],
    COURT_CLERK: ["case:read", "document:read", "document:write", "document:share"],
    FORENSIC_ANALYST: ["document:read", "document:write", "document:share"],
    RECORDS_ADMIN: ["document:read", "document:write", "user:read", "document:share"],
    SECURITY_ADMIN: ["document:read", "audit:read", "user:manage", "governance:read", "governance:propose", "governance:approve", "reference:manage"],
    ORG_ADMIN: ["user:manage", "case:manage", "document:manage", "governance:read", "governance:propose", "governance:approve"],
    SYSTEM_ADMIN: ["*"],
    AUDITOR: ["audit:read", "document:read", "case:read", "governance:read", "governance:vote"],
  },
});

// The set of keys a CHANGE_ABAC_POLICY override document may carry. Anything else
// is rejected by validateAbacPolicy (sudoActions.js) before it can be filed.
export const POLICY_KEYS = Object.freeze([
  "clearanceRank",
  "elevatedCaseRoles",
  "crossJurisdictionRoles",
  "permissionAliases",
  "permissionsByRole",
]);

// Layer an override document onto the defaults. Object-valued keys shallow-merge
// (override or add individual entries — e.g. change one role's permissions
// without restating the rest); the array-valued elevatedCaseRoles replaces
// wholesale when present (arrays have no meaningful key-wise merge).
export function mergePolicy(base, override) {
  if (!override || typeof override !== "object") return base;
  return {
    clearanceRank: { ...base.clearanceRank, ...(override.clearanceRank ?? {}) },
    elevatedCaseRoles: override.elevatedCaseRoles ?? base.elevatedCaseRoles,
    crossJurisdictionRoles: override.crossJurisdictionRoles ?? base.crossJurisdictionRoles,
    permissionAliases: { ...base.permissionAliases, ...(override.permissionAliases ?? {}) },
    permissionsByRole: { ...base.permissionsByRole, ...(override.permissionsByRole ?? {}) },
  };
}

const TTL_MS = 15_000;
let cached = mergePolicy(DEFAULT_POLICY, null); // usable synchronously from t=0
let loadedAtMs = 0; // 0 ⇒ never loaded ⇒ next getActivePolicy() reads the DB
let inflight = null;

async function loadFromDb() {
  const [row] = await db
    .select({ policy: abacPolicies.policy })
    .from(abacPolicies)
    .orderBy(desc(abacPolicies.version))
    .limit(1);
  cached = mergePolicy(DEFAULT_POLICY, row?.policy ?? null);
}

// Async accessor for the PDP: refreshes when the cache is older than TTL_MS, then
// returns the merged policy. On a DB error the last-known cache is retained
// (fail-open to the previous good policy, not to a blank one) and a reload is
// re-attempted on the next call.
export async function getActivePolicy() {
  const now = Date.now();
  if (loadedAtMs !== 0 && now - loadedAtMs < TTL_MS) return cached;
  if (!inflight) {
    inflight = loadFromDb()
      .then(() => {
        loadedAtMs = Date.now();
      })
      .catch(() => {
        // keep `cached`; leave loadedAtMs so we retry next call
      })
      .finally(() => {
        inflight = null;
      });
  }
  await inflight;
  return cached;
}

// Synchronous read of the last-refreshed policy. Returns DEFAULT_POLICY until the
// first getActivePolicy()/invalidatePolicyCache() runs. Used by the sync DTO
// mapper (toMe); the enforcement path (authorize) awaits getActivePolicy() first,
// so its subsequent sync reads see the fresh value.
export function getActivePolicySync() {
  return cached;
}

// Force an immediate reload — called right AFTER a CHANGE_ABAC_POLICY execute
// commits, so the new version is visible without waiting out the TTL.
export async function invalidatePolicyCache() {
  loadedAtMs = 0;
  await getActivePolicy();
}

// Append a new policy version inside the caller's transaction. version = max+1;
// the unique(version) index is the backstop against two concurrent executes
// landing on the same number. Never UPDATEs/DELETEs — history is the audit trail.
export async function writePolicyVersion(tx, policy, createdBy) {
  const [row] = await tx.select({ value: max(abacPolicies.version) }).from(abacPolicies);
  const nextVersion = Number(row?.value ?? 0) + 1;
  const [inserted] = await tx
    .insert(abacPolicies)
    .values({ version: nextVersion, policy, createdBy })
    .returning();
  return inserted;
}
