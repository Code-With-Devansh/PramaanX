// Data-access + policy over admin_pools / admin_pool_members (GOVERNANCE.md §5).
//
// Every function takes the executor `x` as its first argument — pass a `tx` when
// the call must be atomic with a mutation + its audit row (bootstrap, execute),
// or the global `db` for a standalone read (the controller membership gate). This
// mirrors the tx-first idiom of recordAudit() and documents.repo.
//
// SYSTEM_ADMIN / SECURITY_ADMIN pools are org-less singletons (org IS NULL);
// ORG_ADMIN pools are keyed by org. The partial unique indexes in 0010 enforce
// "one org-less pool per type" and "one ORG_ADMIN pool per org".

import { and, count, eq, isNull } from "drizzle-orm";
import { adminPools, adminPoolMembers } from "../db/schema/index.js";
import { validateThreshold } from "./poolMath.js";

function poolWhere(poolType, org) {
  return and(
    eq(adminPools.poolType, poolType),
    org == null ? isNull(adminPools.orgId) : eq(adminPools.orgId, org),
  );
}

// The single pool for (poolType, org), or null. org defaults to null (org-less).
export async function getPool(x, poolType, org = null) {
  const [row] = await x.select().from(adminPools).where(poolWhere(poolType, org));
  return row ?? null;
}

export async function listMembers(x, poolId) {
  return x
    .select()
    .from(adminPoolMembers)
    .where(eq(adminPoolMembers.poolId, poolId));
}

export async function countMembers(x, poolId) {
  const [row] = await x
    .select({ total: count() })
    .from(adminPoolMembers)
    .where(eq(adminPoolMembers.poolId, poolId));
  return Number(row?.total ?? 0);
}

// Coarse membership check: is userId in the (poolType, org) pool? Used by the
// controller gate and re-checked inside proposals.service. Returns false when the
// pool does not exist yet.
export async function isMember(x, userId, poolType, org = null) {
  const pool = await getPool(x, poolType, org);
  if (!pool) return false;
  const [row] = await x
    .select({ id: adminPoolMembers.id })
    .from(adminPoolMembers)
    .where(
      and(eq(adminPoolMembers.poolId, pool.id), eq(adminPoolMembers.userId, userId)),
    )
    .limit(1);
  return Boolean(row);
}

// Create a pool with a validated threshold. m is typically the initial roster
// size; k defaults to the majority when omitted.
export async function createPool(x, { poolType, org = null, k, m }) {
  const t = validateThreshold(k, m);
  const [row] = await x
    .insert(adminPools)
    .values({ poolType, orgId: org ?? null, k: t.k, m: t.m })
    .returning();
  return row;
}

export async function addMember(x, poolId, userId) {
  const [row] = await x
    .insert(adminPoolMembers)
    .values({ poolId, userId })
    .returning();
  return row;
}

export async function removeMember(x, poolId, userId) {
  const [row] = await x
    .delete(adminPoolMembers)
    .where(
      and(eq(adminPoolMembers.poolId, poolId), eq(adminPoolMembers.userId, userId)),
    )
    .returning();
  return row ?? null;
}

// Set a new (k, m) pair on a pool, re-validating the quorum. The caller computes
// the target pair (execute derives m from the roster edit); this is the single
// writer of admin_pools.k/m after creation. Touches updatedAt.
export async function setThreshold(x, poolId, { k, m }) {
  const t = validateThreshold(k, m);
  const [row] = await x
    .update(adminPools)
    .set({ k: t.k, m: t.m, updatedAt: new Date() })
    .where(eq(adminPools.id, poolId))
    .returning();
  return row ?? null;
}
