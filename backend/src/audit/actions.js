// Canonical labels for audit_log.action and .target_type. Kept as plain string
// constants (the DB column is text, not an enum) so adding an action never needs
// a migration. Import these instead of hardcoding strings at call sites.
export const AuditAction = Object.freeze({
  DOCUMENT_CREATED: "DOCUMENT_CREATED",
  VERSION_ADDED: "VERSION_ADDED",
  VERSION_RESTORED: "VERSION_RESTORED",
  VERSION_DOWNLOADED: "VERSION_DOWNLOADED",
  // Ledger anchoring (blockchain integrity layer). Emitted by the anchor worker,
  // not the request path: VERSION_ANCHORED when a version's hash commits to the
  // ledger, VERSION_ANCHOR_FAILED when anchoring is abandoned after retries.
  VERSION_ANCHORED: "VERSION_ANCHORED",
  VERSION_ANCHOR_FAILED: "VERSION_ANCHOR_FAILED",
  // Integrity verify (request path): a version's stored bytes were re-hashed and
  // checked against the mirror + the on-chain anchor. details carries the verdict.
  VERSION_VERIFIED: "VERSION_VERIFIED",
  // Emitted by POST /documents/:id/seal (real auth + MFA step-up).
  DOCUMENT_SEALED: "DOCUMENT_SEALED",
  // Wired once the corresponding endpoint lands:
  DOCUMENT_DELETED: "DOCUMENT_DELETED",
  // POST /documents/:id/access — read-only, time-bound, per-user grant. GRANTED
  // covers both a first grant and a renewal (expiresAt update) of an existing
  // one; details distinguishes them + whether the grant crosses jurisdiction.
  DOCUMENT_ACCESS_GRANTED: "DOCUMENT_ACCESS_GRANTED",
  DOCUMENT_ACCESS_REVOKED: "DOCUMENT_ACCESS_REVOKED",
  VERSION_PROCESSED: "VERSION_PROCESSED",
  VERSION_PROCESSING_FAILED: "VERSION_PROCESSING_FAILED",

  // ---- Governance / admin-hierarchy subsystem (GOVERNANCE.md) ----
  // Sudo proposal lifecycle: filed -> each approval/objection -> executed.
  // SUDO_APPROVED/SUDO_OBJECTED carry the approver's pool role in details.
  SUDO_PROPOSAL_FILED: "SUDO_PROPOSAL_FILED",
  SUDO_APPROVED: "SUDO_APPROVED",
  SUDO_OBJECTED: "SUDO_OBJECTED",
  SUDO_EXECUTED: "SUDO_EXECUTED",
  // The genesis (bootstrap) audit entry — seq #0 of the governance chain.
  GENESIS_WRITTEN: "GENESIS_WRITTEN",
  // Tier-1 user-mutation audit (provision / update / deactivate / MFA reset).
  USER_PROVISIONED: "USER_PROVISIONED",
  USER_UPDATED: "USER_UPDATED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_MFA_RESET: "USER_MFA_RESET",
  // CHANGE_ABAC_POLICY execute: a new abac_policies version was appended.
  ABAC_POLICY_CHANGED: "ABAC_POLICY_CHANGED",
  // GENESIS_REPLACEMENT (Tier-3 re-ceremony): the top-tier rosters were replaced.
  GENESIS_REPLACED: "GENESIS_REPLACED",
});

export const TargetType = Object.freeze({
  DOCUMENT: "DOCUMENT",
  VERSION: "VERSION",
  CASE: "CASE",
  GOVERNANCE_PROPOSAL: "GOVERNANCE_PROPOSAL",
  ADMIN_POOL: "ADMIN_POOL",
  USER: "USER",
  ABAC_POLICY: "ABAC_POLICY",
});