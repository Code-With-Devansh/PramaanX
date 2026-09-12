import argon2 from "argon2";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import { randomUUID } from "node:crypto";
import { toMe } from "../mapper/user.mapper.js";
import { generateBackupCodes } from "../utils/generateBackupCodes.js";
import { badRequest, forbidden, invalidCredentials, notFound, unauthenticated, } from "../lib/errors.js";
import {
    signAccessToken,
    signMfaToken,
    signRefreshToken,
    signStepUpToken,
    verifyStepUpToken,
    getAccessExpiryTime,
    getRefreshExpiryTime
} from "../lib/tokens.js";

import userRepository from "../repositories/user.repository.js";
import redisClient from "../config/redis.js";
import {
    hashRefreshToken,
    hashActivationToken,
    hashAccessToken,
    accessTokenKey,
    refreshTokenKey,
} from "../utils/hashToken.js";
import * as activationTokenRepo from "../repositories/activation-token.repository.js";
import { activation_tokens, users } from "../db/schema/index.js";

import { db } from "../db/index.js";
import { and, eq } from "drizzle-orm";


// Step 1 of login: validate credentials and hand back a short-lived MFA token
export async function login({ username, password }) {
    const user = await userRepository.findActiveByUsername(username);
    if (!user) throw invalidCredentials("Invalid username or password.");

    const passwordValid = await argon2.verify(user.hashedPassword, password);
    if (!passwordValid) throw invalidCredentials("Invalid username or password");

    const mfaToken = signMfaToken({ sub: user.id, username: user.username });
    if (user.mfaEnrolled) {
        return { mfaRequired: true, mfaToken };
    }
    return { mfaRequired: false, mfaToken };
}

export async function changePassword(userId, { oldPassword, newPassword }) {
    if (oldPassword === newPassword) {
        throw badRequest("New password cannot be the same as the old password.");
    }

    const user = await userRepository.findActiveById(userId);
    if (!user) {
        throw notFound("User not found.");
    }

    const passwordValid = await argon2.verify(user.hashedPassword, oldPassword);

    if (!passwordValid) {
        throw invalidCredentials("Old password is incorrect.");
    }

    const passwordHash = await argon2.hash(newPassword);

    await userRepository.setPasswordHash(userId, passwordHash);

}


export async function activateAccount({ activationToken, newPassword }) {
    const tokenHash = hashActivationToken(activationToken);
    await db.transaction(async (tx) => {
        const [claimedToken] = await tx
            .update(activation_tokens)
            .set({ used: true })
            .where(
                and(
                    eq(activation_tokens.token, tokenHash),
                    eq(activation_tokens.used, false)
                )
            )
            .returning();

        if (!claimedToken) {
            throw badRequest("Invalid or already-used activation token.");
        }

        const passwordHash = await argon2.hash(newPassword);
        await tx
            .update(users)
            .set({ hashedPassword: passwordHash })
            .where(eq(users.id, claimedToken.userId));
    });
}

// Begin first-time MFA enrollment: generate a TOTP secret + QR for the
// authenticator app and stash the secret as pending on the user.
export async function startMfaEnrollment(userId) {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw notFound("User not found");
    if (user.mfaEnrolled) {
        throw badRequest("User is already enrolled in MFA");
    }

    const secret = speakeasy.generateSecret({
        name: `DMS (${user.username})`,
        issuer: "DMS",
    });
    await userRepository.setPendingMfaSecret(userId, secret.base32);
    const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
    return {
        secret: secret.base32,
        otpAuthUrl: secret.otpauth_url,
        qrDataUrl,
    };
}

// Finish first-time enrollment: verify the first code against the pending secret,
// promote it to the active secret, generate backup codes, and issue tokens.
export async function verifyMfaEnrollment(userId, code) {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw notFound("User not found");
    if (user.mfaEnrolled) {
        throw badRequest("User is already enrolled in MFA");
    }
    if (!user.mfaTempSecret) throw badRequest("No pending MFA enrollment found");
    const verified = speakeasy.totp.verify({
        secret: user.mfaTempSecret,
        token: code,
        encoding: "base32", window: 1,
    });

    if (!verified) throw badRequest("Invalid MFA code");
    const backupCodes = generateBackupCodes(8);
    const hashedCodes = await Promise.all(
        backupCodes.map(async (code) => {
            const hash = await argon2.hash(code);
            return { codeHash: hash, used: false };
        })
    );
    const stringifiedCodes = JSON.stringify(hashedCodes);


    const refreshToken = signRefreshToken({ sub: user.id, username: user.username });
    const accessToken = signAccessToken({ sub: user.id, username: user.username, role: user.role });
    await userRepository.completeMfaEnrollment({
        userId,
        tempSecret: user.mfaTempSecret,
        backupCodes: stringifiedCodes,
        refreshToken,
    });
    const freshUser = await userRepository.findById(userId);

    const accessExpiryTime = getAccessExpiryTime(accessToken) - Date.now() / 1000;
    const refreshExpiryTime = getRefreshExpiryTime(refreshToken) - Date.now() / 1000;
    await redisClient.set(refreshTokenKey(userId), hashRefreshToken(refreshToken), {
        "EX": Math.round(refreshExpiryTime)
    });
    await redisClient.set(accessTokenKey(userId), hashAccessToken(accessToken), {
        "EX": Math.round(accessExpiryTime)
    });

    return { backupCodes, user: toMe(freshUser), accessToken, refreshToken };
}

// Regular login MFA step: verify a code against the active secret and issue tokens.
export async function verifyMfa(userId, code) {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw notFound("User not found");
    if (!user.mfaSecret || !user.mfaEnrolled) {
        throw badRequest("User is not enrolled in MFA");
    }
    const verified = speakeasy.totp.verify({
        secret: user.mfaSecret,
        token: code,
        encoding: "base32", window: 1,
    });
    if (!verified) throw unauthenticated("Invalid MFA code");
    const accessToken = signAccessToken({ sub: user.id, username: user.username, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, username: user.username });
    await userRepository.completeMfaLogin({ userId, refreshToken });


    const accessExpiryTime = getAccessExpiryTime(accessToken) - Date.now() / 1000;
    const refreshExpiryTime = getRefreshExpiryTime(refreshToken) - Date.now() / 1000;

    await redisClient.set(refreshTokenKey(userId), hashRefreshToken(refreshToken), {
        "EX": Math.round(refreshExpiryTime)
    });
    await redisClient.set(accessTokenKey(userId), hashAccessToken(accessToken), {
        "EX": Math.round(accessExpiryTime)
    });

    const freshUser = await userRepository.findActiveById(userId);
    return { user: toMe(freshUser), accessToken, refreshToken };
}

export async function createStepUpToken(userId, code) {
    const user = await userRepository.findActiveById(userId);
    if (!user || user.status !== "ACTIVE") {
        throw notFound("User not found");
    }
    if (!user.mfaSecret || !user.mfaEnrolled) {
        throw badRequest("User is not enrolled in MFA");
    }

    const verified = speakeasy.totp.verify({
        secret: user.mfaSecret,
        token: code,
        encoding: "base32", window: 1,
    });
    if (!verified) throw unauthenticated("Invalid MFA code");

    // jti makes each step-up token single-use as a governance vote: the
    // governance approve path persists it under a UNIQUE constraint, so replaying
    // the same token (even against a different proposal) is rejected as a conflict.
    const stepUpToken = signStepUpToken({ sub: user.id, jti: randomUUID() });
    const payload = verifyStepUpToken(stepUpToken);
    return {
        stepUpToken,
        expiresAt: new Date(payload.exp * 1000),
    };
}


// Exchange a valid refresh token for a fresh access token (refresh stays put).
export async function refresh(userId) {
    
    const user = await userRepository.findActiveById(userId);
    if (!user) throw notFound("User not found");


    const accessToken = signAccessToken({ sub: userId, username: user.username, role: user.role });
    const refreshToken = signRefreshToken({ sub: userId, username: user.username });

    await userRepository.addRefreshToken({ userId, refreshToken });

    await redisClient.set(refreshTokenKey(userId), hashRefreshToken(refreshToken), {
        "EX": Math.round(getRefreshExpiryTime(refreshToken) - Date.now() / 1000)
    });
    await redisClient.set(accessTokenKey(userId), hashAccessToken(accessToken), {
        "EX": Math.round(getAccessExpiryTime(accessToken) - Date.now() / 1000)
    });
    return { accessToken, newRefreshToken: refreshToken };
}

export async function logout(userId, prevRefreshToken) {
    const user = await userRepository.findById(userId);
    if (!user) throw notFound("User not found");
    const [refreshToken] = await userRepository.getRefreshTokenByUserId(userId);
    if (!refreshToken) throw notFound("Refresh token not found");
    if (!prevRefreshToken) throw notFound("Previous refresh token not found");
    if (refreshToken.tokenHash !== hashRefreshToken(prevRefreshToken)) {
        throw notFound("Previous refresh token is invalid");
    }
    
    await userRepository.revokeRefreshTokenForUser(userId);
    await redisClient.del(refreshTokenKey(userId));
    await redisClient.del(accessTokenKey(userId));
}

export async function revokeRefreshToken(userId) {
    await userRepository.revokeRefreshTokenForUser(userId);
    await redisClient.del(refreshTokenKey(userId));
    await redisClient.del(accessTokenKey(userId));
}


// Current-user profile for GET /me (id comes from the verified access token).
export async function getMe(userId) {
    const user = await userRepository.findActiveById(userId);
    if (!user) throw notFound("User not found");
    return toMe(user);
}


