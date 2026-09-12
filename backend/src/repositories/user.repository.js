
import { db } from "../db/index.js";

import { users } from "../db/schema/users.js";
import { refreshTokens } from "../db/schema/refresh_tokens.js";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { hashRefreshToken } from "../utils/hashToken.js";
import { getRefreshExpiryTime } from "../lib/tokens.js";


class UserRepository {

    async list({ role, orgId, status, q, page, pageSize }) {
        const filters = [];
        if (role) filters.push(eq(users.role, role));
        if (orgId) filters.push(eq(users.orgId, orgId));
        if (status) filters.push(eq(users.status, status));
        if (q) {
            const query = `%${q}%`;
            filters.push(or(ilike(users.fullName, query), ilike(users.email, query), ilike(users.username, query)));
        }

        const where = filters.length ? and(...filters) : undefined;
        const [items, [{ total }]] = await Promise.all([
            db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
            db.select({ total: sql`count(*)`.mapWith(Number) }).from(users).where(where),
        ]);

        return { items, total };
    }

    async findByUsername(username) {
        const [user] = await db
            .select()
            .from(users)
            .where(eq(users.username, username))
            .limit(1);

        return user;
    }

    async findById(id) {
        const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
        return user;
    }

    async findByEmail(email) {
        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        return user;
    }

    async create(data) {
        const [user] = await db.insert(users).values(data).returning();
        return user;
    }

    async update(id, data) {
        const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
        return user;
    }

    async resetMfa(id) {
        await db.update(users).set({ mfaEnrolled: false, mfaSecret: null, mfaTempSecret: null, backupCodes: null }).where(eq(users.id, id));
    }

    async findActiveByUsername(username) {
        const [user] = await db.select().from(users).where(and(eq(users.username, username), eq(users.status, "ACTIVE"))).limit(1);
        return user;
    }

    async findActiveById(id) {
        const [user] = await db.select().from(users).where(and(eq(users.id, id), eq(users.status, "ACTIVE"))).limit(1);
        return user;
    }

    async setPasswordHash(id, hashedPassword) {
        await db.update(users).set({ hashedPassword }).where(eq(users.id, id));
    }

    async setPendingMfaSecret(id, mfaTempSecret) {
        await db.update(users).set({ mfaTempSecret }).where(eq(users.id, id));
    }

    async completeMfaEnrollment({ userId, tempSecret, backupCodes, refreshToken }) {
        const expiresAt = getRefreshExpiryTime(refreshToken) * 1000;
        return db.transaction(async (tx) => {
            await tx.update(users).set({
                mfaTempSecret: null,
                mfaSecret: tempSecret,
                mfaEnrolled: true,
                lastLoginAt: new Date(),
                backupCodes,
            }).where(eq(users.id, userId));

            const existingToken = await tx.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).limit(1);

            if (existingToken.length > 0) {

                await tx.update(refreshTokens).set({
                    tokenHash: hashRefreshToken(refreshToken), revokedAt: null, expiresAt: new Date(expiresAt)
                })
                    .where(eq(refreshTokens.userId, userId));
            } else {
                await tx.insert(refreshTokens).values({
                    userId,
                    tokenHash: hashRefreshToken(refreshToken),
                    revokedAt: null,
                    expiresAt: new Date(expiresAt)
                });
            }
        });
    }

    async completeMfaLogin({ userId, refreshToken }) {
        const expiresAt = getRefreshExpiryTime(refreshToken) * 1000;
        
        return db.transaction(async (tx) => {
            await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
            const existingToken = await tx.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).limit(1);
            if (existingToken.length > 0) {
                await tx.update(refreshTokens)
                    .set({
                        tokenHash: hashRefreshToken(refreshToken),
                        revokedAt: null,
                        expiresAt: new Date(expiresAt)
                    })
                    .where(eq(refreshTokens.userId, userId));
            } else {
                await tx.insert(refreshTokens).values({
                    userId,
                    tokenHash: hashRefreshToken(refreshToken),
                    revokedAt: null,
                    expiresAt: new Date(expiresAt)
                });
            }
        });
    }

    async revokeRefreshTokenForUser(userId) {
        await db.transaction(async (tx) => {
            await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
        });
    }

    async getRefreshTokenByUserId(userId) {
        return db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).limit(1);
    }

    async revokeRefreshTokenForUser(userId) {
        return db.transaction(async (tx) => {
            await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
        });
    }

    async addRefreshToken({ userId, refreshToken }) {
        const existingToken = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).limit(1);
        if (existingToken.length > 0) {
            await db.update(refreshTokens).set({
                tokenHash: hashRefreshToken(refreshToken),
                revokedAt: null,
                expiresAt: new Date(getRefreshExpiryTime(refreshToken) * 1000),
            }).where(eq(refreshTokens.userId, userId));
        } else {
            await db.insert(refreshTokens).values({
                userId,
                tokenHash: hashRefreshToken(refreshToken),
                expiresAt: new Date(getRefreshExpiryTime(refreshToken) * 1000),
            });
        }
    }

}

const userRepository = new UserRepository();
export default userRepository;
