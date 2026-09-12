import express from "express";
import request from "supertest";
import { jest, beforeEach, describe, expect, it } from "@jest/globals";

// Route-level tests for the governance subsystem + the provisionUser admin-tier
// guard. Mirrors test/auth.route.test.js: every DB-touching module is mocked via
// jest.unstable_mockModule so no Postgres/Redis is needed. We assert the HTTP
// contract (status codes, that the mocked service is called with parsed args),
// not the quorum SQL — those live in the manual end-to-end run (plan §11).

// ── governance service (facade the controller imports) ───────────────────────
const governanceService = {
  bootstrap: jest.fn(),
  regenesis: jest.fn(),
  fileProposal: jest.fn(),
  approveProposal: jest.fn(),
  objectProposal: jest.fn(),
  executeProposal: jest.fn(),
  listProposals: jest.fn(),
  getProposal: jest.fn(),
};

// ── authorize(): the coarse RBAC gate. Default allow; the service is where the
// authoritative pool-membership check lives (and is mocked out here). ──────────
const authorize = jest.fn().mockResolvedValue(true);
const requirePoolMembership = jest.fn().mockResolvedValue(true);

// ── users service is the REAL module (we test its admin-tier guard), so we must
// mock everything IT imports that would touch a DB. ──────────────────────────
const usersRepo = {
  list: jest.fn(),
  findByEmail: jest.fn(),
  findByUsername: jest.fn(),
  findById: jest.fn(),
};
const refreshTokenRepo = {
  revokeAllForUser: jest.fn(),
  listActiveForUser: jest.fn(),
  findById: jest.fn(),
  revokeById: jest.fn(),
};
const recordAudit = jest.fn();
const db = { transaction: jest.fn(async (fn) => fn({})) };

// requireAuth reads redis to check token revocation; stub it "not revoked".
const redisClient = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), exists: jest.fn() };
// requireAuth / requireStepUp verify JWTs; stub the verifiers.
const tokens = {
  verifyAccessToken: jest.fn(() => ({ sub: "actor-1", username: "root", role: "SYSTEM_ADMIN" })),
  verifyStepUpToken: jest.fn(() => ({ sub: "actor-1", jti: "jti-123" })),
};

jest.unstable_mockModule("../src/services/governance.service.js", () => governanceService);
jest.unstable_mockModule("../src/lib/authorize.js", () => ({ authorize, requirePoolMembership }));
jest.unstable_mockModule("../src/repositories/user.repository.js", () => ({ default: usersRepo }));
jest.unstable_mockModule("../src/repositories/refresh-token.repository.js", () => ({ default: refreshTokenRepo }));
jest.unstable_mockModule("../src/audit/index.js", () => ({
  recordAudit,
  AuditAction: { USER_PROVISIONED: "USER_PROVISIONED", USER_UPDATED: "USER_UPDATED", USER_DEACTIVATED: "USER_DEACTIVATED", USER_MFA_RESET: "USER_MFA_RESET" },
  TargetType: { USER: "USER" },
}));
jest.unstable_mockModule("../src/db/index.js", () => ({ db }));
jest.unstable_mockModule("../src/config/redis.js", () => ({ default: redisClient }));
jest.unstable_mockModule("../src/lib/tokens.js", () => tokens);

const { default: governanceRouter } = await import("../src/routes/governance.route.js");
const { default: usersRouter } = await import("../src/routes/users.route.js");
const { errorHandler } = await import("../src/middlewares/error.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  // Inject an authenticated admin so authRequired routes proceed to the handler
  // under test (real requireAuth is exercised separately below via the header path).
  app.use("/api/v1", governanceRouter);
  app.use("/api/v1", usersRouter);
  app.use(errorHandler);
  return app;
}

const app = createTestApp();
const AUTH = { Authorization: "Bearer access-token" };

beforeEach(() => {
  jest.clearAllMocks();
  authorize.mockResolvedValue(true);
  requirePoolMembership.mockResolvedValue(true);
  redisClient.get.mockResolvedValue(null);
  tokens.verifyAccessToken.mockReturnValue({ sub: "actor-1", username: "root", role: "SYSTEM_ADMIN" });
  tokens.verifyStepUpToken.mockReturnValue({ sub: "actor-1", jti: "jti-123" });
});

describe("governance bootstrap (unauthenticated genesis route)", () => {
  it("rejects invalid bootstrap input with 400 VALIDATION and does not call the service", async () => {
    const response = await request(app)
      .post("/api/v1/governance/bootstrap")
      .send({ secret: "", roster: [], pools: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION");
    expect(governanceService.bootstrap).not.toHaveBeenCalled();
  });

  it("passes a valid genesis payload to the service and returns 201", async () => {
    governanceService.bootstrap.mockResolvedValue({ pools: 1, users: 2 });
    const payload = {
      secret: "founding-secret",
      roster: [
        { fullName: "Ada", email: "ada@x.example", role: "SYSTEM_ADMIN", org: "hq", clearance: "SECRET", jurisdiction: "fed" },
        { fullName: "Grace", email: "grace@x.example", role: "SYSTEM_ADMIN", org: "hq", clearance: "SECRET", jurisdiction: "fed" },
      ],
      pools: [{ poolType: "SYSTEM_ADMIN", members: ["ada@x.example", "grace@x.example"] }],
    };

    const response = await request(app).post("/api/v1/governance/bootstrap").send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ pools: 1, users: 2 });
    expect(governanceService.bootstrap).toHaveBeenCalledTimes(1);
    // secret + roster + pools reach the service; emails are lower-cased by zod.
    const [arg] = governanceService.bootstrap.mock.calls[0];
    expect(arg.secret).toBe("founding-secret");
    expect(arg.roster).toHaveLength(2);
    expect(arg.pools[0].poolType).toBe("SYSTEM_ADMIN");
  });
});

describe("governance regenesis (unauthenticated Tier-3 route)", () => {
  it("is reachable WITHOUT auth and forwards a valid payload to the service (201)", async () => {
    governanceService.regenesis.mockResolvedValue({ regenesised: true });
    const payload = {
      secret: "founding-secret",
      roster: [
        { fullName: "Ada", email: "ada@x.example", role: "SYSTEM_ADMIN", org: "hq", clearance: "SECRET", jurisdiction: "fed" },
        { fullName: "Grace", email: "grace@x.example", role: "SYSTEM_ADMIN", org: "hq", clearance: "SECRET", jurisdiction: "fed" },
      ],
      pools: [{ poolType: "SYSTEM_ADMIN", members: ["ada@x.example", "grace@x.example"] }],
    };

    const response = await request(app).post("/api/v1/governance/regenesis").send(payload);

    expect(response.status).toBe(201);
    expect(governanceService.regenesis).toHaveBeenCalledTimes(1);
    const [arg] = governanceService.regenesis.mock.calls[0];
    expect(arg.secret).toBe("founding-secret");
    expect(arg.pools[0].poolType).toBe("SYSTEM_ADMIN");
  });

  it("rejects an empty roster with 400 VALIDATION, service untouched", async () => {
    const response = await request(app)
      .post("/api/v1/governance/regenesis")
      .send({ secret: "s", roster: [], pools: [] });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION");
    expect(governanceService.regenesis).not.toHaveBeenCalled();
  });
});

describe("governance proposals (auth + step-up)", () => {
  it("files a CHANGE_ABAC_POLICY proposal, forwarding the passthrough policy doc", async () => {
    governanceService.fileProposal.mockResolvedValue({ id: "prop-abac", status: "PENDING" });
    const policy = { permissionsByRole: { AUDITOR: ["audit:read", "governance:vote"] } };

    const response = await request(app)
      .post("/api/v1/governance/proposals")
      .set(AUTH)
      .send({ actionType: "CHANGE_ABAC_POLICY", payload: { policy } });

    expect(response.status).toBe(201);
    const [, body] = governanceService.fileProposal.mock.calls[0];
    // the nested policy object survives zod (not key-stripped)
    expect(body.payload.policy).toEqual(policy);
  });

  it("files an ONBOARD_ORG proposal, forwarding the members roster", async () => {
    governanceService.fileProposal.mockResolvedValue({ id: "prop-onboard", status: "PENDING" });
    const members = ["00000000-0000-0000-0000-000000000009", "00000000-0000-0000-0000-00000000000a"];

    const response = await request(app)
      .post("/api/v1/governance/proposals")
      .set(AUTH)
      .send({ actionType: "ONBOARD_ORG", payload: { org: "a06d33aa-49f1-4fb1-9e10-3c9392f88e81", members } });

    expect(response.status).toBe(201);
    const [, body] = governanceService.fileProposal.mock.calls[0];
    expect(body.payload.members).toEqual(members);
    expect(body.payload.org).toBe("a06d33aa-49f1-4fb1-9e10-3c9392f88e81");
  });

  it("files a proposal, forwarding parsed (actorId, body, ip) to the service", async () => {
    governanceService.fileProposal.mockResolvedValue({ id: "prop-1", status: "PENDING" });

    const response = await request(app)
      .post("/api/v1/governance/proposals")
      .set(AUTH)
      .send({ actionType: "APPOINT_ORG_ADMIN", payload: { org: "3f87f0b0-0d40-42e0-915b-b47e25214200", userId: "00000000-0000-0000-0000-000000000009" } });

    expect(response.status).toBe(201);
    expect(governanceService.fileProposal).toHaveBeenCalledTimes(1);
    const [actorId, body] = governanceService.fileProposal.mock.calls[0];
    expect(actorId).toBe("actor-1");
    expect(body).toEqual({ actionType: "APPOINT_ORG_ADMIN", payload: { org: "3f87f0b0-0d40-42e0-915b-b47e25214200", userId: "00000000-0000-0000-0000-000000000009" } });
  });

  it("rejects a proposal with an unknown actionType (400) without hitting the service", async () => {
    const response = await request(app)
      .post("/api/v1/governance/proposals")
      .set(AUTH)
      .send({ actionType: "NOT_A_REAL_ACTION", payload: {} });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION");
    expect(governanceService.fileProposal).not.toHaveBeenCalled();
  });

  it("rejects approve WITHOUT a step-up token: 403 STEP_UP_REQUIRED, service untouched", async () => {
    const response = await request(app)
      .post("/api/v1/governance/proposals/00000000-0000-0000-0000-000000000001/approve")
      .set(AUTH)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("STEP_UP_REQUIRED");
    expect(governanceService.approveProposal).not.toHaveBeenCalled();
  });

  it("approve WITH a step-up token forwards the token jti as the vote nonce", async () => {
    governanceService.approveProposal.mockResolvedValue({ id: "prop-1", counted: "IN_POOL" });

    const response = await request(app)
      .post("/api/v1/governance/proposals/00000000-0000-0000-0000-000000000001/approve")
      .set(AUTH)
      .set("x-step-up-token", "step-up-token")
      .send({});

    expect(response.status).toBe(201);
    expect(governanceService.approveProposal).toHaveBeenCalledTimes(1);
    const [actorId, proposalId, jti] = governanceService.approveProposal.mock.calls[0];
    expect(actorId).toBe("actor-1");
    expect(proposalId).toBe("00000000-0000-0000-0000-000000000001");
    expect(jti).toBe("jti-123");
  });

  it("requires authentication (no Bearer ⇒ 401), service untouched", async () => {
    const response = await request(app).get("/api/v1/governance/proposals");
    expect(response.status).toBe(401);
    expect(governanceService.listProposals).not.toHaveBeenCalled();
  });
});

describe("provisionUser admin-tier guard (closes the core hole)", () => {
  it.each(["SYSTEM_ADMIN", "SECURITY_ADMIN", "ORG_ADMIN"])(
    "refuses to provision an admin-tier user (%s) with 403 FORBIDDEN",
    async (role) => {
      const response = await request(app)
        .post("/api/v1/users")
        .set(AUTH)
        .send({ fullName: "Mallory", email: "mallory@x.example", role, clearance: "SECRET", jurisdictionId: "239ce294-d19c-49f9-b0aa-41218f93ab4e", orgId: "f0c3de91-0b0d-4824-b793-ad0e39bb7039" });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      // Guard fires before any DB work.
      expect(usersRepo.findByEmail).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it("provisions a non-admin role and writes a USER_PROVISIONED audit row", async () => {
    usersRepo.findByEmail.mockResolvedValue(undefined);
    usersRepo.findByUsername.mockResolvedValue(undefined);
    // db.transaction(fn) runs fn with a tx whose insert(...).returning() yields the row.
    const createdRow = { id: "user-9", role: "INVESTIGATING_OFFICER", orgId: "f0c3de91-0b0d-4824-b793-ad0e39bb7039", email: "newbie@x.example" };
    const tx = {
      insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([createdRow]) })) })),
    };
    db.transaction.mockImplementation(async (fn) => fn(tx));

    const response = await request(app)
      .post("/api/v1/users")
      .set(AUTH)
      .send({ fullName: "Newbie", email: "newbie@x.example", role: "INVESTIGATING_OFFICER", clearance: "CONFIDENTIAL", jurisdictionId: "239ce294-d19c-49f9-b0aa-41218f93ab4e", orgId: "f0c3de91-0b0d-4824-b793-ad0e39bb7039" });

    expect(response.status).toBe(201);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [, entry] = recordAudit.mock.calls[0];
    expect(entry.action).toBe("USER_PROVISIONED");
    expect(entry.targetType).toBe("USER");
    expect(entry.targetId).toBe("user-9");
    // Sensitive fields are stripped from the response.
    expect(response.body.user).not.toHaveProperty("hashedPassword");
    expect(response.body).toHaveProperty("activationToken");
  });
});
