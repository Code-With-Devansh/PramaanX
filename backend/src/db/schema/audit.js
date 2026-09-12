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
// audit_log: append-only, hash-chained record of every mutation and every
// evidence-access event. Tamper-evident — rows are NEVER updated or deleted
// (enforced by triggers in the `audit_chain` custom migration).
//
// Chain: entry_hash = sha256(prev_hash || canonical(payload)), computed in the
// app under a transaction advisory lock so concurrent appends can't fork the
// chain. Genesis prev_hash is 64 zeros. Verification re-walks by `seq`. The
// hashing + append logic lives in src/audit/.
//
// actor_id -> users(id) is added conditionally in the custom migration once the
// (teammate-owned) users table exists, mirroring documents.created_by in 0002.
// ─────────────────────────────────────────────────────────────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Monotonic append order — the sequence the chain is walked/verified in.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    actorId: uuid("actor_id").notNull(),
    // Free-form action label (e.g. DOCUMENT_CREATED). Text, not a pgEnum: the
    // action vocabulary grows over time and shouldn't need a migration each time.
    // Canonical values live in src/audit/actions.js.
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    ip: text("ip"),
    details: jsonb("details"),
    // Tamper-evidence chain links.
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    entryHash: char("entry_hash", { length: 64 }).notNull(),
    // App-generated (NOT defaultNow()): the hash commits to this exact value, so
    // it must be known at insert time and reproduced verbatim on verification.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("audit_log_seq_key").on(t.seq),
    // entry_hash is unique by construction (each links a unique prev + unique id);
    // the constraint is a backstop that surfaces any chain bug loudly.
    unique("audit_log_entry_hash_key").on(t.entryHash),
    index("audit_log_actor_id_idx").on(t.actorId),
    index("audit_log_action_idx").on(t.action),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_created_at_idx").on(t.createdAt),
    check("audit_log_prev_hash_check", sql`${t.prevHash} ~ '^[0-9a-f]{64}$'`),
    check("audit_log_entry_hash_check", sql`${t.entryHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
