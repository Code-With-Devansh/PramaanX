import {
  pgTable,
  uuid,
  text,
  jsonb,
  bigserial,
  char,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// comments: discussion on a case, or on one document within a case.
// document_id NULL => a case-level comment. Soft-deleted (deleted_at), never
// hard-deleted — same evidentiary posture as document_versions. Editing keeps
// the original row; edited_at is stamped, prior text is not retained here
// (the create/edit/delete trail itself lives in case_activity_log below).
// ─────────────────────────────────────────────────────────────────────────────
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    // NULL = case-level comment. Set = document-level comment (case_id is still
    // populated, redundantly, so "all discussion on this case" is one query).
    documentId: uuid("document_id"),
    parentCommentId: uuid("parent_comment_id"),
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    // Resolved @mention targets (user ids), derived server-side from body at
    // write time — never trust client-supplied ids directly (see
    // comments.service#resolveMentions).
    mentions: text("mentions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("comments_body_not_empty_check", sql`length(${t.body}) > 0`),
    index("comments_case_id_idx").on(t.caseId, t.createdAt),
    index("comments_document_id_idx").on(t.documentId, t.createdAt),
    index("comments_parent_comment_id_idx").on(t.parentCommentId),
    index("comments_author_id_idx").on(t.authorId),
    // Live-thread queries only care about non-deleted comments.
    index("comments_active_idx")
      .on(t.caseId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// case_activity_log: append-only, hash-chained log of comment-class events
// (COMMENT_CREATED / COMMENT_EDITED / COMMENT_DELETED, later: mention
// notifications, presence-adjacent events if ever persisted). Structurally
// identical to audit_log (see src/db/schema/audit.js and src/audit/chain.js —
// the hashing helpers there are generic and are reused as-is), but kept as a
// SEPARATE chain so the security-critical audit_log (grants, seals, deletes,
// governance) stays lean and fast to verify. This chain is still global
// (single seq/prev_hash sequence across all cases), not partitioned per case —
// see src/activity/index.js for why.
// ─────────────────────────────────────────────────────────────────────────────
export const caseActivityLog = pgTable(
  "case_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    caseId: uuid("case_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    // Canonical values live in src/activity/actions.js (mirrors audit/actions.js).
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    details: jsonb("details"),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    entryHash: char("entry_hash", { length: 64 }).notNull(),
    // App-generated (NOT defaultNow()) — the hash commits to this exact value.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("case_activity_log_seq_key").on(t.seq),
    unique("case_activity_log_entry_hash_key").on(t.entryHash),
    index("case_activity_log_case_id_idx").on(t.caseId, t.createdAt),
    index("case_activity_log_actor_id_idx").on(t.actorId),
    index("case_activity_log_target_idx").on(t.targetType, t.targetId),
    check("case_activity_log_prev_hash_check", sql`${t.prevHash} ~ '^[0-9a-f]{64}$'`),
    check("case_activity_log_entry_hash_check", sql`${t.entryHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
