// JWT signing/verification for the three token classes used by auth:
//   - access  : short-lived (15m) session token, sent on every request
//   - refresh : longer-lived (1d) token used only to mint new access tokens
//   - mfa     : very short-lived token that carries the user between /login and
//               MFA verification
//
// Each class is signed with its own secret (config.jwt.*Secret) so a leak of one
// cannot forge another. HS256 is pinned on verify to avoid algorithm-confusion.
import jwt from "jsonwebtoken";
import config from "../config/index.js";

const { jwt: cfg } = config;
const SIGN_OPTS = { algorithm: "HS256" };
const VERIFY_OPTS = { algorithms: ["HS256"] };

// token "type" claim guards against a token of one class being replayed as
// another (e.g. presenting a refresh token where an access token is expected).
function sign(payload, secret, expiresIn, type) {
  return jwt.sign({ ...payload, type }, secret, { ...SIGN_OPTS, expiresIn });
}

function verify(token, secret, type) {
  const decoded = jwt.verify(token, secret, VERIFY_OPTS);
  if (decoded.type !== type) {
    throw new Error(`expected ${type} token but got ${decoded.type}`);
  }
  return decoded;
}

export function signAccessToken(payload) {
  return sign(payload, cfg.accessSecret, cfg.accessExpiresIn, "access");
}

export function signRefreshToken(payload) {
  return sign(payload, cfg.refreshSecret, cfg.refreshExpiresIn, "refresh");
}

export function signMfaToken(payload) {
  return sign(payload, cfg.mfaSecret, cfg.mfaExpiresIn, "mfa");
}

export function signStepUpToken(payload) {
  return sign(payload, cfg.mfaSecret, cfg.stepUpExpiresIn, "step-up");
}

export function verifyAccessToken(token) {
  return verify(token, cfg.accessSecret, "access");
}

export function verifyRefreshToken(token) {
  return verify(token, cfg.refreshSecret, "refresh");
}

export function verifyMfaToken(token) {
  return verify(token, cfg.mfaSecret, "mfa");
}

export function verifyStepUpToken(token) {
  return verify(token, cfg.mfaSecret, "step-up");
}

export function getUserIdFromMfaToken(token) {
  const decoded = verifyMfaToken(token);
  return decoded.sub;
}

export function getUserIdFromRefreshToken(token) {
  const decoded = verifyRefreshToken(token);
  return decoded.sub;
}
export function getRefreshExpiryTime(token) {
  const decoded = verifyRefreshToken(token);
  return decoded.exp;
}

export function getAccessExpiryTime(token) {
  const decoded = verifyAccessToken(token);
  return decoded.exp;
}