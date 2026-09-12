import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { users } from "../db/schema/users.js";
import { recordAudit, AuditAction, TargetType } from "../audit/index.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import userRepository from "../repositories/user.repository.js";
import refreshTokenRepository from "../repositories/refresh-token.repository.js";
import * as activationTokenRepo from "../repositories/activation-token.repository.js";
import { activation_tokens } from "../db/schema/index.js";
import { hashActivationToken, hashAccessToken } from "../utils/hashToken.js"



// Roles whose membership is governed by admin pools + quorum (GOVERNANCE.md),
// never minted by a single admin through the user-CRUD path. Provisioning or
// promoting into any of these must go through a /governance proposal.
const ADMIN_TIER_ROLES = new Set(["SYSTEM_ADMIN", "SECURITY_ADMIN", "ORG_ADMIN"]);

function publicUser(user) {
    const { hashedPassword, mfaSecret, mfaTempSecret, backupCodes, username, ...safeUser } = user;
    return safeUser;
}

function assertOrgScope(actor, targetOrgId) {
    if (actor.role === "ORG_ADMIN" && actor.orgId !== targetOrgId) {
        throw forbidden("organization administrator cannot access another organization");
    }
}

export async function listUsers(actor, filters) {
    const scopedFilters = actor.role === "ORG_ADMIN" ? { ...filters, orgId: actor.orgId } : filters;
    const result = await userRepository.list(scopedFilters);
    return { ...result, items: result.items.map(publicUser) };
}

export async function provisionUser(actor, data, ip) {
    assertOrgScope(actor, data.orgId);
    // Closes the core governance hole: a single admin can no longer unilaterally
    // create another privileged identity. Admin-tier appointments are quorum-gated.
    if (ADMIN_TIER_ROLES.has(data.role)) {
        throw forbidden("admin-tier users must be provisioned via /governance proposals");
    }
    if (await userRepository.findByEmail(data.email)) throw conflict("A user with this email already exists");

    const baseUsername = data.email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "user";
    let username = baseUsername;
    for (let suffix = 1; await userRepository.findByUsername(username); suffix += 1) username = `${baseUsername}-${suffix}`;

    const activationToken = randomBytes(32).toString("hex");
    const hashedPassword = await argon2.hash(randomBytes(32).toString("base64url"));

    // Insert + audit atomically: no user row without its USER_PROVISIONED entry.
    const user = await db.transaction(async (tx) => {

        const [created] = await tx.insert(users).values({
            ...data,
            username,
            hashedPassword,
            status: "ACTIVE",
        }).returning();
        await recordAudit(tx, {
            actorId: actor.id,
            action: AuditAction.USER_PROVISIONED,
            targetType: TargetType.USER,
            targetId: created.id,
            ip,
            details: { role: created.role, orgId: created.orgId, email: created.email },
        });


        await tx.insert(activation_tokens).values({
            userId: created.id,
            token: hashActivationToken(activationToken),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        }).returning();


        return created;
    });

    return { user: publicUser(user), activationToken };
}

export async function getUser(actor, userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw notFound("User not found");
    assertOrgScope(actor, user.orgId);
    return publicUser(user);
}

export async function updateUser(actor, userId, data, ip) {
    const current = await userRepository.findById(userId);
    if (!current) throw notFound("User not found");
    assertOrgScope(actor, current.orgId);
    // A role change may never move a user *into* an admin tier through this path;
    // that is an appointment and must be a quorum-approved governance proposal.
    if (data.role && ADMIN_TIER_ROLES.has(data.role)) {
        throw forbidden("promoting a user into an admin tier must go through /governance proposals");
    }

    const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(users).set(data).where(eq(users.id, userId)).returning();
        await recordAudit(tx, {
            actorId: actor.id,
            action: AuditAction.USER_UPDATED,
            targetType: TargetType.USER,
            targetId: userId,
            ip,
            details: { changed: data },
        });
        return row;
    });

    return publicUser(updated);
}

export async function deactivateUser(actor, userId, ip) {
    const current = await userRepository.findById(userId);
    if (!current) throw notFound("User not found");
    assertOrgScope(actor, current.orgId);

    const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(users).set({ status: "DISABLED" }).where(eq(users.id, userId)).returning();
        await recordAudit(tx, {
            actorId: actor.id,
            action: AuditAction.USER_DEACTIVATED,
            targetType: TargetType.USER,
            targetId: userId,
            ip,
            details: { previousStatus: current.status },
        });
        return row;
    });

    // Kill live sessions after the deactivation commits. Deliberately outside the
    // audit transaction: revokeByUserId also writes revocation tombstones to Redis.
    await refreshTokenRepository.revokeByUserId(userId);
    return publicUser(updated);
}

export async function resetMfa(actor, userId, ip) {
    const current = await userRepository.findById(userId);
    if (!current) throw notFound("User not found");
    assertOrgScope(actor, current.orgId);

    await db.transaction(async (tx) => {
        await tx.update(users).set({
            mfaEnrolled: false,
            mfaSecret: null,
            mfaTempSecret: null,
            backupCodes: null,
        }).where(eq(users.id, userId));
        await recordAudit(tx, {
            actorId: actor.id,
            action: AuditAction.USER_MFA_RESET,
            targetType: TargetType.USER,
            targetId: userId,
            ip,
        });
    });

    await refreshTokenRepository.revokeByUserId(userId);
}

export async function listSessions(actor, userId) {
    const user = await getUser(actor, userId);
    const sessions = await refreshTokenRepository.listActiveForUser(user.id);
    return sessions.map((session) => ({ ...session, ip: "unknown", device: "unknown", lastSeenAt: session.createdAt }));
}

export async function revokeSession(actor, sessionId) {
    const session = await refreshTokenRepository.findById(sessionId);
    if (!session) throw notFound("Session not found");
    await getUser(actor, session.userId);
    await refreshTokenRepository.revokeById(sessionId, session.userId);
}
