import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { refreshTokens } from "../db/schema/refresh_tokens.js";

import  redisClient from "../config/redis.js";
import { hashRefreshToken, accessTokenKey, refreshTokenKey } from "../utils/hashToken.js";



class RefreshTokenRepository {
    async findById(id) {
        const [refreshToken] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, id)).limit(1);
        return refreshToken;
    }

    async revokeById(id, userId) {
        await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.id, id), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    }
    async create({ token, userId, expiresAt }) {
        const [refreshToken] = await db
            .insert(refreshTokens)
            .values({
                userId,
                tokenHash: hashRefreshToken(token),
                expiresAt,
            })
            .returning({ id: refreshTokens.id });

        return refreshToken;
    }

    async findActiveByToken(token) {
        const [refreshToken] = await db
            .select()
            .from(refreshTokens)
            .where(
                and(
                    eq(refreshTokens.tokenHash, hashRefreshToken(token)),
                    isNull(refreshTokens.revokedAt),
                ),
            )
            .limit(1);

        return refreshToken;
    }

    async findByToken(token) {
        const [refreshToken] = await db
            .select()
            .from(refreshTokens)
            .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)))
            .limit(1);
        return refreshToken;
    }

    async revokeToken(token) {
        const refreshToken = await this.findByToken(token);
        if (refreshToken) {
            await db
                .update(refreshTokens)
                .set({ revokedAt: new Date() })
                .where(eq(refreshTokens.id, refreshToken.id));
            await redisClient.del(refreshTokenKey(refreshToken.userId));
        }
    }

    async revokeByUserId(userId) {
        await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    }

    async listActiveForUser(userId) {
        const tokens = await db
            .select()
            .from(refreshTokens)
            .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
        return tokens;
    }

    async findByUserId(userId){
        const [refreshToken] = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)).limit(1);
        return refreshToken;
    }
    
    
}

export default new RefreshTokenRepository();