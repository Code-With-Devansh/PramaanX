// Sudo-proposal orchestration (GOVERNANCE.md §5). Every mutating op runs in one
// db.transaction together with its recordAudit(...) row, so a proposal, vote,
// objection or execution is never observable without its audit trail and never
// audited if it rolls back.
//
// Trust model: the client is never trusted for authority. The caller's role /
// pool membership is re-loaded from the DB on every op (never read off the JWT),
// eligibility and quorum are computed from the SUDO_ACTIONS registry + the actual
// admin_pools / sudo_approvals rows, and execute re-derives quorum from scratch
// rather than trusting any "approved" flag. Per-proposal ops SELECT ... FOR UPDATE
// the proposal row so concurrent votes/executions serialize.

import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  sudoProposals,
  sudoApprovals,
  sudoObjections,
  users,
} from "../db/schema/index.js";
import { recordAudit, AuditAction, TargetType } from "../audit/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import config from "../config/index.js";
import userRepository from "../repositories/user.repository.js";
import { getAction, resolveCrossTier } from "./sudoActions.js";
import * as pools from "./pools.js";
import { defaultK, validateThreshold } from "./poolMath.js";
import { writePolicyVersion, invalidatePolicyCache } from "../lib/abacPolicy.js";

// pg unique-violation SQLSTATE. node-postgres surfaces err.code + err.constraint.
function isUniqueViolation(err, constraint) {
  return err?.code === "23505" && (!constraint || err?.constraint === constraint);
}

// Turn a poolMath / registry validation Error into a 400 (leaves ApiError as-is).
function asBadRequest(err) {
  return err?.status ? err : badRequest(err?.message || "invalid governance payload");
}

async function loadActiveActor(actorId) {
  const actor = await userRepository.findById(actorId);
  if (!actor || actor.status !== "ACTIVE") {
    throw forbidden("actor is not an active user");
  }
  return actor;
}

// A pool never counts as its own cross-tier co-signer: if the effective
// cross-tier spec is the SAME org-less pool as the target, there is no distinct
// co-signer and the cross-tier requirement is void (the guard falls to the other
// quorums). isSelfTier compares the resolved cross-tier spec to the target.
function isSelfTier(targetSpec, crossSpec) {
  return (
    !!crossSpec &&
    crossSpec.poolType === targetSpec.poolType &&
    (crossSpec.org ?? null) === (targetSpec.org ?? null)
  );
}

// Map a cross-tier pool type to its approver_pool_role enum label.
function crossTierRole(poolType) {
  if (poolType === "SECURITY_ADMIN") return "CROSS_TIER_SECURITY_ADMIN";
  if (poolType === "SYSTEM_ADMIN") return "SYSTEM_ADMIN_QUORUM";
  return null;
}

// Count active AUDITOR-role users — the pool of eligible Tier-2 auditor voters
// (POOL_REINSTATEMENT). Role-based, not a pool (see the approved design).
async function countActiveAuditors(x) {
  const [{ total }] = await x
    .select({ total: count() })
    .from(users)
    .where(and(eq(users.role, "AUDITOR"), eq(users.status, "ACTIVE")));
  return Number(total);
}

// Classify how `actor` is entitled to act on a proposal whose action governs
// `targetSpec`. Returns an approver_pool_role label | null (ineligible):
//   "IN_POOL"                    — member of the governing pool
//   "CROSS_TIER_SECURITY_ADMIN"  — Security-Admin co-signer
//   "SYSTEM_ADMIN_QUORUM"        — System-Admin acknowledger (inverted ABAC)
//   "AUDITOR_VOTE"               — active AUDITOR (auditorQuorum actions)
// Takes the already-loaded actor (needs .id/.role/.status) plus the proposal
// payload (the cross-tier pool may depend on it) to avoid a re-query.
async function classifyApprover(x, actor, action, targetSpec, payload) {
  const actorId = actor.id;
  if (await pools.isMember(x, actorId, targetSpec.poolType, targetSpec.org)) {
    return "IN_POOL";
  }
  const crossSpec = resolveCrossTier(action, payload ?? {});
  if (
    crossSpec &&
    !isSelfTier(targetSpec, crossSpec) &&
    (await pools.isMember(x, actorId, crossSpec.poolType, crossSpec.org))
  ) {
    const role = crossTierRole(crossSpec.poolType);
    if (role) return role;
  }
  if (action.auditorQuorum && actor.role === "AUDITOR" && actor.status === "ACTIVE") {
    return "AUDITOR_VOTE";
  }
  return null;
}

// Resolve + guard the registry entry for an actionType.
function requireSupportedAction(actionType) {
  const action = getAction(actionType);
  if (!action) throw badRequest(`unknown action ${actionType}`);
  if (!action.supported) throw badRequest(`action ${actionType} is not yet supported`);
  return action;
}

function assertGovernanceEnabled() {
  if (!config.governance.enabled) {
    throw forbidden("governance subsystem is disabled");
  }
}

// ── file ───────────────────────────────────────────────────────────────────
// The proposer must be eligible to act on the target pool (a member of it, or a
// Security Admin for a cross-tier-governed action). Files a PENDING proposal.
export async function fileProposal(actorId, { actionType, payload }, ip) {
  assertGovernanceEnabled();
  const action = requireSupportedAction(actionType);
  try {
    action.validatePayload(payload);
  } catch (err) {
    throw asBadRequest(err);
  }
  const targetSpec = action.targetPool(payload);

  return db.transaction(async (tx) => {
    const actor = await loadActiveActor(actorId);

    const targetPool = await pools.getPool(tx, targetSpec.poolType, targetSpec.org);
    if (!targetPool) throw badRequest("target pool does not exist");

    // Eligible to propose: in the target pool, or an eligible co-signer.
    const role = await classifyApprover(tx, actor, action, targetSpec, payload);
    if (!role) throw forbidden("not eligible to propose against this pool");

    const delayHours = action.delayHours || 0;
    const executesAfter =
      delayHours > 0 ? new Date(Date.now() + delayHours * 3_600_000) : null;

    const [proposal] = await tx
      .insert(sudoProposals)
      .values({
        actionType,
        payload,
        status: "PENDING",
        proposedBy: actorId,
        orgId: targetSpec.org ?? null,
        executesAfter,
      })
      .returning();

    await recordAudit(tx, {
      actorId,
      action: AuditAction.SUDO_PROPOSAL_FILED,
      targetType: TargetType.GOVERNANCE_PROPOSAL,
      targetId: proposal.id,
      ip,
      details: { actionType, targetPool: targetSpec },
    });

    return proposal;
  });
}

// ── approve ──────────────────────────────────────────────────────────────────
// One freshly-authenticated step-up vote. stepUpJti (from req.stepUp) is persisted
// under UNIQUE(step_up_token_jti): reusing a token — even on a different proposal —
// is a 409. UNIQUE(proposal_id, approver_id) blocks a second vote by the same person.
export async function approveProposal(actorId, proposalId, stepUpJti, ip) {
  assertGovernanceEnabled();
  if (!stepUpJti) throw forbidden("step-up token is missing its jti; re-authenticate");

  return db.transaction(async (tx) => {
    const actor = await loadActiveActor(actorId);

    const [proposal] = await tx
      .select()
      .from(sudoProposals)
      .where(eq(sudoProposals.id, proposalId))
      .for("update");
    if (!proposal) throw notFound("proposal not found");
    if (proposal.status !== "PENDING") {
      throw conflict(`proposal is ${proposal.status.toLowerCase()}, not open for approval`);
    }

    const action = requireSupportedAction(proposal.actionType);
    const targetSpec = action.targetPool(proposal.payload);

    const approverPoolRole = await classifyApprover(tx, actor, action, targetSpec, proposal.payload);
    if (!approverPoolRole) throw forbidden("not eligible to approve this proposal");

    let approval;
    try {
      [approval] = await tx
        .insert(sudoApprovals)
        .values({ proposalId, approverId: actorId, approverPoolRole, stepUpTokenJti: stepUpJti })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, "sudo_approvals_proposal_id_approver_id_key")) {
        throw conflict("you have already voted on this proposal");
      }
      if (isUniqueViolation(err, "sudo_approvals_step_up_token_jti_key")) {
        throw conflict("this step-up token has already been used to vote");
      }
      throw err;
    }

    await recordAudit(tx, {
      actorId,
      action: AuditAction.SUDO_APPROVED,
      targetType: TargetType.GOVERNANCE_PROPOSAL,
      targetId: proposalId,
      ip,
      details: { approverPoolRole },
    });

    return approval;
  });
}

// ── object ───────────────────────────────────────────────────────────────────
// A reviewer eligible to approve may instead object. Once minObjectorsToHalt
// objections land, the proposal flips to OBJECTED and can no longer be approved
// or executed (fail-safe halt).
export async function objectProposal(actorId, proposalId, reason, ip) {
  assertGovernanceEnabled();

  return db.transaction(async (tx) => {
    const actor = await loadActiveActor(actorId);

    const [proposal] = await tx
      .select()
      .from(sudoProposals)
      .where(eq(sudoProposals.id, proposalId))
      .for("update");
    if (!proposal) throw notFound("proposal not found");
    if (proposal.status !== "PENDING") {
      throw conflict(`proposal is ${proposal.status.toLowerCase()}, not open for objection`);
    }

    const action = requireSupportedAction(proposal.actionType);
    const targetSpec = action.targetPool(proposal.payload);
    const role = await classifyApprover(tx, actor, action, targetSpec, proposal.payload);
    if (!role) throw forbidden("not eligible to object to this proposal");

    await tx
      .insert(sudoObjections)
      .values({ proposalId, objectorId: actorId, reason: reason ?? null });

    const [{ total }] = await tx
      .select({ total: count() })
      .from(sudoObjections)
      .where(eq(sudoObjections.proposalId, proposalId));

    const halted = Number(total) >= config.governance.minObjectorsToHalt;
    if (halted) {
      await tx
        .update(sudoProposals)
        .set({ status: "OBJECTED" })
        .where(eq(sudoProposals.id, proposalId));
    }

    await recordAudit(tx, {
      actorId,
      action: AuditAction.SUDO_OBJECTED,
      targetType: TargetType.GOVERNANCE_PROPOSAL,
      targetId: proposalId,
      ip,
      details: { reason: reason ?? null, halted },
    });

    return { proposalId, halted, status: halted ? "OBJECTED" : "PENDING" };
  });
}

// ── execute ──────────────────────────────────────────────────────────────────
// Re-derives quorum from the actual approval rows (never a client flag): the
// target pool's k in-pool votes AND ≥1 cross-tier Security-Admin co-sign, and any
// executesAfter delay elapsed. Then applies the pool mutation and records
// SUDO_EXECUTED, linking the proposal to that audit entry.
export async function executeProposal(actorId, proposalId, ip) {
  assertGovernanceEnabled();

  // executeProposal returns {updated, invalidateAbac}; the ABAC cache is
  // invalidated AFTER the tx commits (below) so a concurrent read can't re-cache
  // the pre-commit policy.
  const { updated, invalidateAbac } = await db.transaction(async (tx) => {
    const actor = await loadActiveActor(actorId);

    const [proposal] = await tx
      .select()
      .from(sudoProposals)
      .where(eq(sudoProposals.id, proposalId))
      .for("update");
    if (!proposal) throw notFound("proposal not found");
    if (proposal.status !== "PENDING") {
      throw conflict(`proposal is ${proposal.status.toLowerCase()}, not executable`);
    }

    const action = requireSupportedAction(proposal.actionType);
    const payload = proposal.payload;
    const targetSpec = action.targetPool(payload);

    // The executor must themselves be an eligible party to the pool.
    const executorRole = await classifyApprover(tx, actor, action, targetSpec, payload);
    if (!executorRole) throw forbidden("not eligible to execute this proposal");

    if (proposal.executesAfter && proposal.executesAfter.getTime() > Date.now()) {
      throw conflict("proposal delay window has not elapsed");
    }

    const targetPool = await pools.getPool(tx, targetSpec.poolType, targetSpec.org);
    if (!targetPool) throw badRequest("target pool no longer exists");

    // ── Quorum from the real approval rows (never a client/stored flag) ────────
    const approvals = await tx
      .select()
      .from(sudoApprovals)
      .where(eq(sudoApprovals.proposalId, proposalId));
    const roleCount = (r) => approvals.filter((a) => a.approverPoolRole === r).length;
    const inPool = roleCount("IN_POOL");

    if (inPool < targetPool.k) {
      throw conflict(`quorum not met: ${inPool}/${targetPool.k} in-pool approvals`);
    }

    // Cross-tier co-sign (only when a distinct cross-tier pool is in effect).
    const crossSpec = resolveCrossTier(action, payload);
    if (crossSpec && !isSelfTier(targetSpec, crossSpec)) {
      const crossRole = crossTierRole(crossSpec.poolType);
      const crossCount = roleCount(crossRole);
      if (action.crossTierQuorum) {
        const crossPool = await pools.getPool(tx, crossSpec.poolType, crossSpec.org);
        if (!crossPool) throw badRequest("cross-tier pool does not exist");
        if (crossCount < crossPool.k) {
          throw conflict(
            `quorum not met: ${crossCount}/${crossPool.k} ${crossSpec.poolType} acknowledgements`,
          );
        }
      } else if (crossCount < 1) {
        throw conflict("quorum not met: a cross-tier co-sign is required");
      }
    }

    // Auditor quorum (Tier-2 POOL_REINSTATEMENT): k-of-P active auditors.
    // P === 0 ⇒ fail-closed: operators must provision auditors for recovery.
    if (action.auditorQuorum) {
      const auditorVotes = roleCount("AUDITOR_VOTE");
      const P = await countActiveAuditors(tx);
      const auditorK = P === 0 ? Infinity : Math.floor(P / 2) + 1;
      if (auditorVotes < auditorK) {
        throw conflict(
          `quorum not met: ${auditorVotes}/${P === 0 ? "∞" : auditorK} auditor votes`,
        );
      }
    }

    // ── Apply the mutation. Pool membership is the authority of record; we do
    // NOT mutate users.role here (RBAC is the coarse gate). Roster edits keep the
    // stored k and guard m so a pool can never be driven ungovernable. ──────────
    let auditTargetType = TargetType.ADMIN_POOL;
    let auditTargetId = targetPool.id;
    let auditAction = AuditAction.SUDO_EXECUTED;
    let extraDetails = {};
    let invalidateAbac = false;

    if (proposal.actionType === "APPOINT_ORG_ADMIN" || proposal.actionType === "APPOINT_SYSTEM_ADMIN") {
      const target = await userRepository.findById(payload.userId);
      if (!target) throw notFound("target user not found");
      if (await pools.isMember(tx, payload.userId, targetSpec.poolType, targetSpec.org)) {
        throw conflict("user is already a member of this pool");
      }
      await pools.addMember(tx, targetPool.id, payload.userId);
      await pools.setThreshold(tx, targetPool.id, { k: targetPool.k, m: targetPool.m + 1 });
    } else if (proposal.actionType === "REMOVE_ORG_ADMIN" || proposal.actionType === "REMOVE_SYSTEM_ADMIN") {
      const newM = targetPool.m - 1;
      if (newM < 2 || targetPool.k > newM) {
        throw badRequest(
          "cannot remove: pool would fall below its quorum; lower k via CHANGE_POOL_THRESHOLD first",
        );
      }
      const removed = await pools.removeMember(tx, targetPool.id, payload.userId);
      if (!removed) throw notFound("user is not a member of this pool");
      await pools.setThreshold(tx, targetPool.id, { k: targetPool.k, m: newM });
    } else if (proposal.actionType === "CHANGE_POOL_THRESHOLD") {
      try {
        await pools.setThreshold(tx, targetPool.id, { k: payload.k, m: targetPool.m });
      } catch (err) {
        throw asBadRequest(err);
      }
    } else if (proposal.actionType === "ONBOARD_ORG") {
      const affected = await onboardOrg(tx, payload);
      auditTargetId = affected.id;
      extraDetails = { org: payload.org, poolType: "ORG_ADMIN" };
    } else if (proposal.actionType === "CHANGE_ABAC_POLICY") {
      const row = await writePolicyVersion(tx, payload.policy, actor.id);
      auditAction = AuditAction.ABAC_POLICY_CHANGED;
      auditTargetType = TargetType.ABAC_POLICY;
      auditTargetId = row.id;
      extraDetails = { version: row.version };
      invalidateAbac = true;
    } else if (proposal.actionType === "POOL_REINSTATEMENT") {
      const affected = await reinstatePool(tx, payload);
      auditTargetId = affected.id;
      extraDetails = { poolType: payload.poolType, org: payload.org ?? null };
    } else {
      // Unreachable: requireSupportedAction gates the set above.
      throw badRequest(`execution not implemented for ${proposal.actionType}`);
    }

    const auditRow = await recordAudit(tx, {
      actorId: actor.id,
      action: auditAction,
      targetType: auditTargetType,
      targetId: auditTargetId,
      ip,
      details: { proposalId, actionType: proposal.actionType, ...extraDetails },
    });

    const [updated] = await tx
      .update(sudoProposals)
      .set({ status: "EXECUTED", executedAt: new Date(), executedEntryId: auditRow.id })
      .where(eq(sudoProposals.id, proposalId))
      .returning();

    return { updated, invalidateAbac };
  });

  if (invalidateAbac) await invalidatePolicyCache();
  return updated;
}

// ── ONBOARD_ORG execute helper ────────────────────────────────────────────────
// Create a brand-new ORG_ADMIN pool + its roster, all inside the execute tx.
async function onboardOrg(tx, payload) {
  const existing = await pools.getPool(tx, "ORG_ADMIN", payload.org);
  if (existing) throw conflict(`an ORG_ADMIN pool for '${payload.org}' already exists`);

  const memberIds = dedupe(payload.members);
  for (const uid of memberIds) {
    const u = await userRepository.findById(uid);
    if (!u || u.status !== "ACTIVE") throw badRequest(`member ${uid} is not an active user`);
  }
  const m = memberIds.length;
  const k = payload.k ?? defaultK(m);
  try {
    validateThreshold(k, m);
  } catch (err) {
    throw asBadRequest(err);
  }

  const pool = await pools.createPool(tx, { poolType: "ORG_ADMIN", org: payload.org, k, m });
  for (const uid of memberIds) {
    await pools.addMember(tx, pool.id, uid);
  }
  return pool;
}

// ── POOL_REINSTATEMENT execute helper ─────────────────────────────────────────
// Reconcile the affected pool to `members`: create it if fully dissolved, else
// add/remove members to match the roster, then re-threshold. The delay window is
// already enforced by the executesAfter check in executeProposal.
async function reinstatePool(tx, payload) {
  const org = payload.poolType === "ORG_ADMIN" ? payload.org : null;
  const memberIds = dedupe(payload.members);
  for (const uid of memberIds) {
    const u = await userRepository.findById(uid);
    if (!u || u.status !== "ACTIVE") throw badRequest(`member ${uid} is not an active user`);
  }
  const m = memberIds.length;
  const k = payload.k ?? defaultK(m);
  try {
    validateThreshold(k, m);
  } catch (err) {
    throw asBadRequest(err);
  }

  let pool = await pools.getPool(tx, payload.poolType, org);
  if (!pool) {
    pool = await pools.createPool(tx, { poolType: payload.poolType, org, k, m });
    for (const uid of memberIds) await pools.addMember(tx, pool.id, uid);
    return pool;
  }

  // Reconcile existing membership to the target roster.
  const current = await pools.listMembers(tx, pool.id);
  const currentIds = new Set(current.map((r) => r.userId));
  const targetIds = new Set(memberIds);
  for (const uid of memberIds) {
    if (!currentIds.has(uid)) await pools.addMember(tx, pool.id, uid);
  }
  for (const uid of currentIds) {
    if (!targetIds.has(uid)) await pools.removeMember(tx, pool.id, uid);
  }
  await pools.setThreshold(tx, pool.id, { k, m });
  return pool;
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// ── reads (no audit) ──────────────────────────────────────────────────────────
export async function listProposals({ status, actionType, org, page = 1, pageSize = 20 }) {
  const conds = [];
  if (status) conds.push(eq(sudoProposals.status, status));
  if (actionType) conds.push(eq(sudoProposals.actionType, actionType));
  if (org) conds.push(eq(sudoProposals.orgId, org));
  const where = conds.length ? and(...conds) : undefined;

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(sudoProposals)
      .where(where)
      .orderBy(desc(sudoProposals.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(sudoProposals).where(where),
  ]);
  return { items, total: Number(total), page, pageSize };
}

export async function getProposal(proposalId) {
  const [proposal] = await db
    .select()
    .from(sudoProposals)
    .where(eq(sudoProposals.id, proposalId));
  if (!proposal) throw notFound("proposal not found");

  const [approvals, objections] = await Promise.all([
    db.select().from(sudoApprovals).where(eq(sudoApprovals.proposalId, proposalId)),
    db.select().from(sudoObjections).where(eq(sudoObjections.proposalId, proposalId)),
  ]);
  return { ...proposal, approvals, objections };
}
