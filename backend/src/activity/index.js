import { randomUUID } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import { caseActivityLog } from "../db/schema/index.js";
// Deliberately reused, not duplicated: entry_hash = sha256(prev_hash ||
// canonical(payload)) is a generic construction that doesn't care which table
// it's chaining. GENESIS_HASH is the same 64-zero sentinel both chains start
// from.
import { GENESIS_HASH, computeEntryHash } from "../audit/chain.js";

export { CaseActivityAction, ActivityTargetType } from "./actions.js";

// A distinct advisory-lock key from AUDIT_LOCK_KEY (src/audit/index.js) — the
// two chains are independent and must not serialize against each other.
// "CACT" as bytes = 0x43414354.
const CASE_ACTIVITY_LOCK_KEY = 1128485716;

// Append one entry to the case_activity_log chain.
//
// MUST be called with the caller's transaction (`tx`) so the entry commits
// atomically with the comment mutation it records — same contract as
// recordAudit. Chained GLOBALLY (one seq/prev_hash sequence across all cases),
// not per case: this system needs no cross-case ordering proof today, but
// keeping one sequence means "verify the whole comment history" is a single
// linear walk, and a future per-case partition can still be derived from
// case_id without re-deriving global order. Revisit only if per-case
// chain-of-custody isolation becomes an actual requirement, not just a nicety
// — see the design discussion, that's a bigger structural change (Option B).
export async function recordCaseActivity(tx, { caseId, actorId, action, targetType, targetId, details }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CASE_ACTIVITY_LOCK_KEY})`);

  const [prev] = await tx
    .select({ entryHash: caseActivityLog.entryHash })
    .from(caseActivityLog)
    .orderBy(desc(caseActivityLog.seq))
    .limit(1);
  const prevHash = prev?.entryHash ?? GENESIS_HASH;

  const entry = {
    id: randomUUID(),
    actorId,
    action,
    targetType,
    targetId: targetId ?? null,
    // entryPayload() (audit/chain.js) only hashes {id, actorId, action,
    // targetType, targetId, ip, details, createdAt}; ip is irrelevant here so
    // it's omitted from the insert and simply reads as null in the payload.
    details: details ?? null,
    createdAt: new Date(),
  };

  const entryHash = computeEntryHash(prevHash, entry);

  await tx.insert(caseActivityLog).values({
    id: entry.id,
    caseId,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: entry.details,
    prevHash,
    entryHash,
    createdAt: entry.createdAt,
  });

  return entry;
}
