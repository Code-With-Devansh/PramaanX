// One-time genesis ceremony (GOVERNANCE.md §6.4). Establishes the first admin
// pools + their founding members and writes the genesis audit entry — the root of
// the governance chain. Self-disabling: the precondition is simply "admin_pools is
// empty", checked under an advisory lock, so a second call can never succeed.
//
// SECURITY: this endpoint is necessarily unauthenticated (no admin exists yet). It
// is gated by (a) a secret commitment — sha256(providedSecret) must equal the
// pre-configured GOVERNANCE_GENESIS_COMMITMENT — and (b) the empty-admin_pools
// precondition, and is intended to be called only over an admin-only channel by
// the genesis CLI. The founding secret itself is NEVER persisted; genesis_shares
// stores holder LABELS and cold-storage flags ONLY — never Shamir share material.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { count, sql, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, adminPools, genesisShares, activation_tokens, orgs, jurisdictions } from "../db/schema/index.js";
import { recordAudit, AuditAction, TargetType } from "../audit/index.js";
import { badRequest, conflict, forbidden } from "../lib/errors.js";
import config from "../config/index.js";
import userRepository from "../repositories/user.repository.js";
import { validateThreshold } from "./poolMath.js";
import * as pools from "./pools.js";
import { hashActivationToken } from "../utils/hashToken.js";

// Stable advisory-lock key serializing the bootstrap precondition check.
// ("GOVB" as bytes = 0x474F5642.)
const BOOTSTRAP_LOCK_KEY = 1196314690;

// Resolve a reference-table (orgs/jurisdictions) row by name to its id, creating
// it if it doesn't exist yet. Genesis-only: this is the one place org/jurisdiction
// names arrive as free text instead of an FK id, because at genesis time the
// lookup tables are necessarily empty. `cache` dedupes repeated names within one
// ceremony call (e.g. every founder in the same org) to a single resolved id and
// a single insert, rather than racing a unique-constraint insert per entry.
async function resolveRefId(tx, table, name, cache) {
  if (cache.has(name)) return cache.get(name);
  const [existing] = await tx.select({ id: table.id }).from(table).where(eq(table.name, name)).limit(1);
  if (existing) {
    cache.set(name, existing.id);
    return existing.id;
  }
  const [created] = await tx.insert(table).values({ name, active: true }).returning({ id: table.id });
  cache.set(name, created.id);
  return created.id;
}

// Constant-time comparison of the provided secret's sha256 against the configured
// commitment. Returns false (rather than throwing) on any shape mismatch.
function commitmentMatches(secret) {
  const configured = config.governance.genesisCommitment;
  if (!configured) return false;
  const provided = createHash("sha256").update(String(secret), "utf8").digest("hex");
  if (provided.length !== configured.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(configured, "hex"));
  } catch {
    return false;
  }
}

function deriveUsername(email) {
  const base =
    email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "user";
  return base;
}

// Resolve a roster entry to a users row id: reuse an existing user by email
// (link), otherwise create one. Runs inside the ceremony tx.
async function upsertRosterUser(tx, entry, usernameTaken, refCache) {
  const existing = await userRepository.findByEmail(entry.email);

  if (existing) {
    return {
      id: existing.id,
      role: existing.role,
      created: false,
      activationToken: null,
    };
  }

  const orgId = await resolveRefId(tx, orgs, entry.org, refCache.orgs);
  const jurisdictionId = await resolveRefId(tx, jurisdictions, entry.jurisdiction, refCache.jurisdictions);

  let username = entry.username || deriveUsername(entry.email);

  for (let suffix = 1; usernameTaken.has(username); suffix += 1) {
    username = `${entry.username || deriveUsername(entry.email)}-${suffix}`;
  }

  usernameTaken.add(username);

  const activationToken = randomBytes(32).toString("base64url");

  const [row] = await tx
    .insert(users)
    .values({
      fullName: entry.fullName,
      role: entry.role,
      orgId,
      badgeId: entry.badgeId ?? null,
      email: entry.email,
      clearance: entry.clearance,
      jurisdictionId,
      status: "ACTIVE",
      username,

      hashedPassword: await argon2.hash(
        randomBytes(32).toString("base64url")
      ),
    })
    .returning();

  await tx.insert(activation_tokens).values({
    userId: row.id,
    token: hashActivationToken(activationToken),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    used: false,
  });

  return {
    id: row.id,
    role: row.role,
    created: true,
    activationToken,
  };
}

// bootstrap({ secret, roster, pools, shares }, ip)
// - roster: [{ fullName, email, role, org, clearance, jurisdiction, badgeId?, username? }]
//   org/jurisdiction are NAMES here (find-or-created in the ceremony tx — see
//   resolveRefId), unlike provisionUser's orgId/jurisdictionId FK ids.
// - pools:  [{ poolType, org?, k?, members: [email, ...] }]  org is also a NAME
//   here (resolved through the same cache as the roster, so matching names land
//   on one orgs row); m = members.length.
// - shares: [{ holderLabel, isColdStored? }]                  (metadata only)
export async function bootstrap({ secret, roster, pools: poolSpecs, shares = [] }, ip) {
  if (!config.governance.enabled) throw forbidden("governance subsystem is disabled");
  if (!commitmentMatches(secret)) throw forbidden("genesis secret does not match commitment");
  if (!Array.isArray(roster) || roster.length === 0) throw badRequest("roster must be non-empty");
  if (!Array.isArray(poolSpecs) || poolSpecs.length === 0) throw badRequest("at least one pool is required");

  // Pre-validate every threshold before touching the DB (fail fast, no partial state).
  for (const spec of poolSpecs) {
    const m = Array.isArray(spec.members) ? spec.members.length : 0;
    try {
      validateThreshold(spec.k, m);
    } catch (err) {
      throw badRequest(`pool ${spec.poolType}${spec.org ? `/${spec.org}` : ""}: ${err.message}`);
    }
  }

  return db.transaction(async (tx) => {
    // Serialize + enforce the one-time precondition: admin_pools must be empty.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    const [{ existing }] = await tx.select({ existing: count() }).from(adminPools);
    if (Number(existing) > 0) throw conflict("governance has already been bootstrapped");

    // Create/link founders, keyed by email.
    const usernameTaken = new Set();
    const byEmail = new Map();
    const activations = [];
    const refCache = { orgs: new Map(), jurisdictions: new Map() };

    for (const entry of roster) {
      const u = await upsertRosterUser(tx, entry, usernameTaken, refCache);

      byEmail.set(entry.email, u);

      if (u.created && u.activationToken) {
        activations.push({
          email: entry.email,
          username: entry.username || deriveUsername(entry.email),
          activationToken: u.activationToken,
        });
      }
}

    // Create pools + attach members. Pool org names resolve through the same
    // refCache as the roster, so an ORG_ADMIN pool for "acme" lands on the same
    // orgs row as any founder whose roster entry says org: "acme".
    const createdPools = [];
    for (const spec of poolSpecs) {
      const m = spec.members.length;
      const orgId = spec.org ? await resolveRefId(tx, orgs, spec.org, refCache.orgs) : null;
      const pool = await pools.createPool(tx, {
        poolType: spec.poolType,
        org: orgId,
        k: spec.k,
        m,
      });
      for (const email of spec.members) {
        const member = byEmail.get(email);
        if (!member) throw badRequest(`pool member ${email} is not in the roster`);
        await pools.addMember(tx, pool.id, member.id);
      }
      createdPools.push({ id: pool.id, poolType: pool.poolType, org: pool.orgId, k: pool.k, m: pool.m });
    }

    // Genesis audit entry #0. actor_id is a NOT NULL FK → users(id); use the first
    // System Admin founder (fall back to the first founder) so the FK resolves.
    const founders = roster.map((e) => byEmail.get(e.email));
    const genesisActor =
      founders.find((f) => f.role === "SYSTEM_ADMIN") || founders[0];

    const genesisEntry = await recordAudit(tx, {
      actorId: genesisActor.id,
      action: AuditAction.GENESIS_WRITTEN,
      targetType: TargetType.ADMIN_POOL,
      targetId: null,
      ip,
      details: {
        pools: createdPools.map((p) => ({ poolType: p.poolType, org: p.org, k: p.k, m: p.m })),
        founders: roster.length,
        shares: shares.length,
      },
    });

    // Genesis share METADATA only — never the shares themselves.
    for (const s of shares) {
      await tx.insert(genesisShares).values({
        holderLabel: s.holderLabel,
        isColdStored: s.isColdStored ?? true,
        distributedAt: null,
      });
    }

    return {
      bootstrapped: true,
      genesisEntryId: genesisEntry.id,
      pools: createdPools,
      founders: founders.length,
      shares: shares.length,
      activations,
    };
  });
}

// regenesis({ secret, roster, pools }, ip)  — Tier-3 recovery (GOVERNANCE.md §7.3).
//
// When the ENTIRE top tier is locked out (SYSTEM_ADMIN + SECURITY_ADMIN pools
// have fallen below quorum simultaneously), no healthy pool remains to vote a
// POOL_REINSTATEMENT, so recovery cannot be a quorum proposal. Instead a fresh
// share-authorized ceremony — gated on the SAME constant-time genesis commitment
// as bootstrap — SUPERSEDES the org-less top-tier pool memberships with a new
// roster. It does NOT touch the secret, the commitment, or genesis_shares
// metadata; those are unchanged (the commitment is what authorizes this call).
//
// Difference from bootstrap: bootstrap requires admin_pools EMPTY; regenesis
// requires the top-tier pools to EXIST (you are replacing, not founding). Only
// SYSTEM_ADMIN / SECURITY_ADMIN memberships are rewritten; ORG_ADMIN pools are
// left intact.
export async function regenesis({ secret, roster, pools: poolSpecs }, ip) {
  if (!config.governance.enabled) throw forbidden("governance subsystem is disabled");
  if (!commitmentMatches(secret)) throw forbidden("genesis secret does not match commitment");
  if (!Array.isArray(roster) || roster.length === 0) throw badRequest("roster must be non-empty");
  if (!Array.isArray(poolSpecs) || poolSpecs.length === 0) throw badRequest("at least one pool is required");

  // Regenesis only rewrites the org-less top-tier pools.
  for (const spec of poolSpecs) {
    if (!["SYSTEM_ADMIN", "SECURITY_ADMIN"].includes(spec.poolType)) {
      throw badRequest(`regenesis only replaces SYSTEM_ADMIN/SECURITY_ADMIN pools, not ${spec.poolType}`);
    }
    const m = Array.isArray(spec.members) ? spec.members.length : 0;
    try {
      validateThreshold(spec.k, m);
    } catch (err) {
      throw badRequest(`pool ${spec.poolType}: ${err.message}`);
    }
  }

  return db.transaction(async (tx) => {
    // Serialize under the same advisory lock as bootstrap.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    const [{ existing }] = await tx.select({ existing: count() }).from(adminPools);
    if (Number(existing) === 0) throw conflict("governance has not been bootstrapped; use bootstrap");

    // Create/link the replacement founders.
    const usernameTaken = new Set();
    const byEmail = new Map();
    const refCache = { orgs: new Map(), jurisdictions: new Map() };
    for (const entry of roster) {
      const u = await upsertRosterUser(tx, entry, usernameTaken, refCache);
      byEmail.set(entry.email, u);
    }

    const replaced = [];
    for (const spec of poolSpecs) {
      const pool = await pools.getPool(tx, spec.poolType, null);
      if (!pool) throw conflict(`${spec.poolType} pool does not exist; use bootstrap`);

      // Wipe the old membership, then attach the new roster.
      const current = await pools.listMembers(tx, pool.id);
      const newIds = new Set();
      for (const email of spec.members) {
        const member = byEmail.get(email);
        if (!member) throw badRequest(`pool member ${email} is not in the roster`);
        newIds.add(member.id);
      }
      for (const row of current) {
        if (!newIds.has(row.userId)) await pools.removeMember(tx, pool.id, row.userId);
      }
      const existingIds = new Set(current.map((r) => r.userId));
      for (const id of newIds) {
        if (!existingIds.has(id)) await pools.addMember(tx, pool.id, id);
      }
      const m = spec.members.length;
      await pools.setThreshold(tx, pool.id, { k: spec.k ?? undefined, m });
      replaced.push({ id: pool.id, poolType: pool.poolType, k: spec.k ?? m, m });
    }

    const founders = roster.map((e) => byEmail.get(e.email));
    const genesisActor = founders.find((f) => f.role === "SYSTEM_ADMIN") || founders[0];

    const entry = await recordAudit(tx, {
      actorId: genesisActor.id,
      action: AuditAction.GENESIS_REPLACED,
      targetType: TargetType.ADMIN_POOL,
      targetId: null,
      ip,
      details: {
        pools: replaced.map((p) => ({ poolType: p.poolType, k: p.k, m: p.m })),
        founders: roster.length,
      },
    });

    return { regenesised: true, entryId: entry.id, pools: replaced, founders: founders.length };
  });
}
