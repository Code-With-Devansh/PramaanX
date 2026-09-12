import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema/index.js";
import { GENESIS_HASH, computeEntryHash } from "./chain.js";

export { AuditAction, TargetType } from "./actions.js";

// A stable key for the transaction advisory lock that serializes chain appends.
// (int4 range; "AUDI" as bytes = 0x41554449.)
const AUDIT_LOCK_KEY = 1094930505;

// Append one entry to the hash-chained audit log.
//
// MUST be called with the caller's transaction (`tx`) so the entry commits
// atomically with the mutation it records — no mutation without its audit row,
// no audit row for a rolled-back mutation. Acquires a transaction-scoped
// advisory lock, then reads the latest entry_hash as prev_hash; the lock
// serializes the read-modify-write so concurrent appends cannot fork the chain
// (relies on the default READ COMMITTED isolation to see the just-committed tip).
export async function recordAudit(tx, { actorId, action, targetType, targetId, ip, details }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);

  const [prev] = await tx
    .select({ entryHash: auditLog.entryHash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const prevHash = prev?.entryHash ?? GENESIS_HASH;

  const entry = {
    id: randomUUID(),
    actorId,
    action,
    targetType,
    targetId: targetId ?? null,
    ip: ip ?? null,
    details: details ?? null,
    createdAt: new Date(),
  };
  const entryHash = computeEntryHash(prevHash, entry);

  const [row] = await tx
    .insert(auditLog)
    .values({ ...entry, prevHash, entryHash })
    .returning();
  return row;
}

// Contract §Shared AuditEntry shape. actor is a stub {id} until the users table
// is hydratable (mirrors documents' createdBy).
function toAuditDTO(r) {
  return {
    id: r.id,
    actor: { id: r.actorId },
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    ip: r.ip,
    timestamp: r.createdAt,
    entryHash: r.entryHash,
    prevHash: r.prevHash,
    details: r.details ?? undefined,
  };
}

// Paginated audit query for GET /audit (contract §8), newest first.
export async function listAudit(filters, { page, pageSize }) {
  const conds = [];
  if (filters.actorId) conds.push(eq(auditLog.actorId, filters.actorId));
  if (filters.action) conds.push(eq(auditLog.action, filters.action));
  if (filters.targetType) conds.push(eq(auditLog.targetType, filters.targetType));
  if (filters.targetId) conds.push(eq(auditLog.targetId, filters.targetId));
  if (filters.dateFrom) conds.push(gte(auditLog.createdAt, filters.dateFrom));
  if (filters.dateTo) conds.push(lte(auditLog.createdAt, filters.dateTo));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.seq))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ total }] = await db
    .select({ total: count() })
    .from(auditLog)
    .where(where);

  return { items: rows.map(toAuditDTO), total: Number(total), page, pageSize };
}

// Walk the whole chain in seq order and confirm every link: prev_hash matches
// the previous row's entry_hash, and each entry_hash recomputes from its stored
// content. Returns the first break, if any.
export async function verifyAuditChain() {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== prevHash) {
      return { valid: false, count: rows.length, brokenAtSeq: row.seq, reason: "prev_hash does not match previous entry_hash" };
    }
    if (computeEntryHash(row.prevHash, row) !== row.entryHash) {
      return { valid: false, count: rows.length, brokenAtSeq: row.seq, reason: "entry_hash does not match recomputed content hash" };
    }
    prevHash = row.entryHash;
  }
  return { valid: true, count: rows.length };
}
