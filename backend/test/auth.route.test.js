import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { jest, beforeEach, describe, expect, it } from "@jest/globals";

const service = {
  login: jest.fn(),
  changePassword: jest.fn(),
  startMfaEnrollment: jest.fn(),
  verifyMfaEnrollment: jest.fn(),
  verifyMfa: jest.fn(),
  createStepUpToken: jest.fn(),
  refresh: jest.fn(),
  getRefreshTokensByUserId: jest.fn(),
  revokeRefreshTokens: jest.fn(),
  logout: jest.fn(),
  getMe: jest.fn(),
};

const redisClient = {
  exists: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
};

const tokens = {
  getUserIdFromMfaToken: jest.fn(),
  getUserIdFromRefreshToken: jest.fn(),
  verifyAccessToken: jest.fn(),
  verifyStepUpToken: jest.fn(),
};

const hashRefreshToken = jest.fn((token) => `hash:${token}`);

jest.unstable_mockModule("../src/services/auth.service.js", () => service);
jest.unstable_mockModule("../src/config/redis.js", () => ({ default: redisClient }));
jest.unstable_mockModule("../src/lib/tokens.js", () => tokens);
jest.unstable_mockModule("../src/utils/hashRefreshToken.js", () => ({ hashRefreshToken }));

const { default: authRouter } = await import("../src/routes/auth.route.js");
const { errorHandler } = await import("../src/middlewares/error.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/auth", authRouter);
  app.use(errorHandler);
  return app;
}

const app = createTestApp();

beforeEach(() => {
  jest.clearAllMocks();
  redisClient.exists.mockResolvedValue(0);
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue("OK");
});

describe("auth routes", () => {
  it("rejects invalid login input without calling the service", async () => {
    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "", password: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION");
    expect(service.login).not.toHaveBeenCalled();
  });

  it("sets the MFA cookie and clears the refresh cookie after login", async () => {
    service.login.mockResolvedValue({ mfaRequired: true, mfaToken: "mfa-token" });

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "alice", password: "ValidPass1" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mfaRequired: true });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mfa_token=mfa-token"),
        expect.stringContaining("refresh_token=;")
      ])
    );
    expect(service.login).toHaveBeenCalledWith({
      username: "alice",
      password: "ValidPass1",
    });
  });

  it("completes MFA verification and sets the refresh cookie", async () => {
    tokens.getUserIdFromMfaToken.mockReturnValue("user-1");
    service.verifyMfa.mockResolvedValue({
      user: { id: "user-1" },
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    const response = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .set("Cookie", "mfa_token=mfa-token")
      .send({ code: "123456" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: { id: "user-1" }, accessToken: "access-token" });
    expect(service.verifyMfa).toHaveBeenCalledWith("user-1", "123456");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("refresh_token=refresh-token"),
        expect.stringContaining("mfa_token=;")
      ])
    );
  });

  it("rejects MFA verification without the MFA cookie", async () => {
    const response = await request(app)
      .post("/api/v1/auth/mfa/verify")
      .send({ code: "123456" });

    expect(response.status).toBe(400);
    expect(service.verifyMfa).not.toHaveBeenCalled();
  });

  it("rejects malformed access credentials before reaching /me", async () => {
    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Basic credentials");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(service.getMe).not.toHaveBeenCalled();
  });

  it("rejects revoked access tokens", async () => {
    redisClient.get.mockResolvedValue("revoked");

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer access-token");

    expect(response.status).toBe(401);
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns the current user for a valid access token", async () => {
    tokens.verifyAccessToken.mockReturnValue({ sub: "user-1", username: "alice", role: "REVIEWER" });
    service.getMe.mockResolvedValue({ id: "user-1", username: "alice" });

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer access-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: { id: "user-1", username: "alice" } });
    expect(service.getMe).toHaveBeenCalledWith("user-1");
  });

  it("rotates the refresh cookie", async () => {
    tokens.getUserIdFromRefreshToken.mockReturnValue("user-1");
    service.getRefreshTokensByUserId.mockResolvedValue([{ revokedAt: null }]);
    service.refresh.mockResolvedValue({ accessToken: "new-access", newRefreshToken: "new-refresh" });

    const response = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", "refresh_token=old-refresh")
      .set("Authorization", "Bearer old-access");

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBe("new-access");
    expect(service.refresh).toHaveBeenCalledWith("user-1", "old-access", "old-refresh");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("refresh_token=new-refresh")])
    );
  });

  it("returns no body on logout and revokes the session", async () => {
    tokens.verifyAccessToken.mockReturnValue({ sub: "user-1", username: "alice" });
    tokens.getUserIdFromRefreshToken.mockReturnValue("user-1");

    const response = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", "Bearer access-token")
      .set("Cookie", "refresh_token=refresh-token");

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    expect(service.logout).toHaveBeenCalledWith("user-1", "access-token");
  });
});