import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { poolType, sudoActionType, sudoStatus, approverPoolRole } from "./enums.js";
import { orgs } from "./reference.js";

// ─────────────────────────────────────────────────────────────────────────────
// Governance / admin-hierarchy subsystem (GOVERNANCE.md). Admin-tier identities
// are created/removed only through k-of-m quorum proposals, never unilaterally.
//
// Cross-domain FKs (user_id/proposed_by/approver_id/objector_id -> users(id),
// executed_entry_id -> audit_log(id)) are attached in drizzle/0010_governance.sql
// via idempotent DO-blocks, mirroring how documents/audit reference users in
// 0002/0004 — the columns here are plain uuids so this file stays independent of
// table ordering. Same-graph FKs (pool_id, proposal_id) use inline .references().
// ─────────────────────────────────────────────────────────────────────────────

// A quorum pool: the System Admins, the Security Admins, or one org's Org Admins.
// k = floor(m/2)+1 by default with a hard floor of k>=2 (enforced in poolMath.js,
// never trusted from input). `org` is set ONLY for ORG_ADMIN pools; the two
// singleton tiers leave it null.
export const adminPools = pgTable(
  "admin_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolType: poolType("pool_type").notNull(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }),
    k: integer("k").notNull(),
    m: integer("m").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A plain unique(pool_type, org_id) will NOT dedupe null orgs (NULLs are
    // distinct in a UNIQUE constraint), so the singleton tiers need a partial
    // index. One pool per type when org is null; one pool per (type, org) when
    // it isn't.
    uniqueIndex("admin_pools_singleton_idx").on(t.poolType).where(sql`${t.orgId} is null`),
    uniqueIndex("admin_pools_type_org_idx").on(t.poolType, t.orgId).where(sql`${t.orgId} is not null`),
  ],
);

// Membership of a pool. user_id -> users(id) attached in the migration.
export const adminPoolMembers = pgTable(
  "admin_pool_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => adminPools.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("admin_pool_members_pool_id_user_id_key").on(t.poolId, t.userId),
    index("admin_pool_members_pool_id_idx").on(t.poolId),
    index("admin_pool_members_user_id_idx").on(t.userId),
  ],
);

// A sudo action awaiting / having reached quorum. The concrete target (user id,
// pool id, new k/m, roster, org) lives in `payload`; `org` is a denormalized
// scoping convenience. executes_after is null for the no-delay core actions and
// set to now()+delay for the (deferred) Tier-2 reinstatement path.
export const sudoProposals = pgTable(
  "sudo_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionType: sudoActionType("action_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: sudoStatus("status").notNull().default("PENDING"),
    proposedBy: uuid("proposed_by").notNull(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    executesAfter: timestamp("executes_after", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executedEntryId: uuid("executed_entry_id"),
  },
  (t) => [
    index("sudo_proposals_status_idx").on(t.status),
    index("sudo_proposals_action_type_idx").on(t.actionType),
    index("sudo_proposals_proposed_by_idx").on(t.proposedBy),
  ],
);

// One vote. unique(proposal_id, approver_id) enforces "one vote per person per
// proposal" (blocks multiple sessions of the same admin); unique(step_up_token_jti)
// enforces "one freshly-authenticated step-up token = at most one vote" (blocks a
// replayed/reused token from counting twice, even across proposals).
export const sudoApprovals = pgTable(
  "sudo_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => sudoProposals.id, { onDelete: "cascade" }),
    approverId: uuid("approver_id").notNull(),
    approverPoolRole: approverPoolRole("approver_pool_role").notNull(),
    stepUpTokenJti: text("step_up_token_jti").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sudo_approvals_proposal_id_approver_id_key").on(t.proposalId, t.approverId),
    unique("sudo_approvals_step_up_token_jti_key").on(t.stepUpTokenJti),
    index("sudo_approvals_proposal_id_idx").on(t.proposalId),
  ],
);

// Any active admin may object while a proposal is PENDING; the first objection
// halts it (GOVERNANCE.md §7.2 default; min-objectors is a config knob).
export const sudoObjections = pgTable(
  "sudo_objections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => sudoProposals.id, { onDelete: "cascade" }),
    objectorId: uuid("objector_id").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sudo_objections_proposal_id_idx").on(t.proposalId)],
);

// Custody INVENTORY for the K-of-N genesis shares — labels/holders only. The
// share material itself is NEVER stored server-side (GOVERNANCE.md §6.1/§6.5): it
// is distributed out-of-band and returned to cold storage. This table only
// records who holds what, for the Tier-3 recovery audit trail.
export const genesisShares = pgTable("genesis_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  holderLabel: text("holder_label").notNull(),
  distributedAt: timestamp("distributed_at", { withTimezone: true }),
  isColdStored: boolean("is_cold_stored").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
