import { pgEnum } from "drizzle-orm/pg-core";

// Shared vocabulary — single source of truth. `classification` and `doc_type`
// are used by other domains too (users.clearance, cases, acls); teammates must
// IMPORT these, not redefine them (a second pgEnum would emit a duplicate
// CREATE TYPE and break generation).

export const classification = pgEnum("classification", [
  "PUBLIC",
  "RESTRICTED",
  "CONFIDENTIAL",
  "SECRET",
]);


export const docType = pgEnum("doc_type", [
  "FIR",
  "POLICE_REPORT",
  "INVESTIGATION_RECORD",
  "WITNESS_STATEMENT",
  "CHARGE_SHEET",
  "COURT_FILING",
  "EVIDENCE_RECORD",
  "FORENSIC_REPORT",
  "LEGAL_NOTICE",
  "JUDGMENT",
  "OTHER",
]);

// Per-version integrity verdict (content hash vs. ledger). Set by the security layer.
export const integrityStatus = pgEnum("integrity_status", [
  "VERIFIED",
  "TAMPERED",
  "PENDING",
]);

// Per-version async pipeline state (virus scan -> OCR -> index -> ready).
export const processingStatus = pgEnum("processing_status", [
  "SCANNING",
  "OCR",
  "INDEXING",
  "READY",
  "FAILED",
]);

// Per-version blockchain anchoring state. A version is inserted PENDING_LEDGER;
// the async ledger worker anchors its hash on-chain and flips it to ANCHORED
// (writing ledger_tx_id + anchored_at) or FAILED after exhausting retries.
export const ledgerStatus = pgEnum("ledger_status", [
  "PENDING_LEDGER",
  "ANCHORED",
  "FAILED",
])
export const caseStatus = pgEnum("case_status", [
  "OPEN",
  "UNDER_INVESTIGATION",
  "CHARGESHEETED",
  "IN_TRIAL",
  "CLOSED",
  "ARCHIVED",
]);

// ==================================================================================================================
// enums for users table starts here
// ==================================================================================================================

export const status = pgEnum("status", [
    "ACTIVE",
    "DISABLED",
])
export const role = pgEnum("role", [
  "INVESTIGATING_OFFICER",
  "SUPERVISOR",
  "PROSECUTOR",
  "JUDGE",
  "COURT_CLERK",
  "FORENSIC_ANALYST",
  "RECORDS_ADMIN",
  "SECURITY_ADMIN",
  "ORG_ADMIN",
  "SYSTEM_ADMIN",
  "AUDITOR"
])

// ==================================================================================================================
// enums for users ends hers
// ==================================================================================================================


// ==================================================================================================================
// enums for the governance / admin-hierarchy subsystem (GOVERNANCE.md) start here.
// Full value sets are declared up front — including the actions/statuses reserved
// for the deferred Tier-2/Tier-3 recovery passes — so extending governance later
// never needs an `ALTER TYPE ... ADD VALUE` migration.
// ==================================================================================================================

// Which admin tier a quorum pool governs.
export const poolType = pgEnum("pool_type", [
  "SYSTEM_ADMIN",
  "SECURITY_ADMIN",
  "ORG_ADMIN",
]);

// The privileged ("sudo") actions that require k-of-m quorum. Only the first
// three are wired in this pass; the rest are reserved for later passes and are
// rejected as unsupported by the service until then.
export const sudoActionType = pgEnum("sudo_action_type", [
  "APPOINT_ORG_ADMIN",
  "REMOVE_ORG_ADMIN",
  "APPOINT_SYSTEM_ADMIN",
  "REMOVE_SYSTEM_ADMIN",
  "CHANGE_POOL_THRESHOLD",
  "ONBOARD_ORG",
  "CHANGE_ABAC_POLICY",
  "POOL_REINSTATEMENT",
  "GENESIS_REPLACEMENT",
]);

// Lifecycle of a sudo proposal.
export const sudoStatus = pgEnum("sudo_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "OBJECTED",
  "EXECUTED",
  "EXPIRED",
]);

// The capacity in which an approver's vote counts toward a proposal. IN_POOL is
// the in-pool k-of-m quorum; CROSS_TIER_SECURITY_ADMIN is the mandatory external
// co-sign (§5). AUDITOR_VOTE / SYSTEM_ADMIN_QUORUM are reserved for Tier-2 recovery.
export const approverPoolRole = pgEnum("approver_pool_role", [
  "IN_POOL",
  "CROSS_TIER_SECURITY_ADMIN",
  "AUDITOR_VOTE",
  "SYSTEM_ADMIN_QUORUM",
]);

// ==================================================================================================================
// governance enums end here
// ==================================================================================================================

