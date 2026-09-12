import crypto from "crypto";

function hashRefreshToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function hashActivationToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function hashAccessToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function hashUserId(userId) {
    return crypto.createHash("sha256").update(String(userId)).digest("hex");
}

function accessTokenKey(userId) {
    return `access:${hashUserId(userId)}`;
}

function refreshTokenKey(userId) {
    return `refresh:${hashUserId(userId)}`;
}

export {
    hashRefreshToken,
    hashActivationToken,
    hashAccessToken,
    accessTokenKey,
    refreshTokenKey,
};


