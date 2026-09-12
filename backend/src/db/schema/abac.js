import {
  pgTable,
  uuid,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// ABAC policy overlay (GOVERNANCE.md — CHANGE_ABAC_POLICY sudo action).
//
// Each row is a full override DOCUMENT layered on the hardcoded defaults in
// src/lib/abacPolicy.js (DEFAULT_POLICY), which authorize.js + user.mapper.js
// consume. The ACTIVE policy is the row with the highest `version`; with no row
// at all the hardcoded defaults apply verbatim (behavior identical to pre-overlay).
//
// Append-only: a policy change files a new version through the CHANGE_ABAC_POLICY
// quorum proposal (Security-Admin primary + k-of-N System-Admin acknowledgement),
// which INSERTs a new row — existing rows are never UPDATEd or DELETEd, so the
// policy history is itself an audit trail. created_by -> users(id) is attached in
// drizzle/0011_abac_policies.sql (conditional + idempotent, mirroring 0010).
// ─────────────────────────────────────────────────────────────────────────────
export const abacPolicies = pgTable(
  "abac_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    policy: jsonb("policy").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("abac_policies_version_key").on(t.version)],
);
