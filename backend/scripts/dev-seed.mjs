#!/usr/bin/env node
// Dev-only fixture seeder + access-token minter, for manually exercising the
// document-intelligence pipeline over real HTTP without going through the full
// login / MFA / governance-provisioning flow (which is unrelated to this
// feature). Idempotent: safe to run more than once.
//
// Creates (if missing) an org, a jurisdiction, one INVESTIGATING_OFFICER user,
// and one demo case; then mints a real access token for that user (signed with
// the live JWT_ACCESS_SECRET) and registers it in Redis exactly the way
// POST /auth/login does, so `Authorization: Bearer <token>` works against
// every route immediately.
//
// MUST run with the real app environment (DATABASE_URL, REDIS_URL,
// JWT_ACCESS_SECRET) -- i.e. inside a container, not on the bare host:
//
//   docker compose -f docker-compose.dev.yml exec api node scripts/dev-seed.mjs
//
// NEVER use this seeded user for anything but local pipeline testing: its
// hashed_password is a placeholder, not a real credential.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { orgs, jurisdictions, users, cases } from "../src/db/schema/index.js";
import { signAccessToken } from "../src/lib/tokens.js";
import { accessTokenKey, hashAccessToken } from "../src/utils/hashToken.js";
import redisClient from "../src/config/redis.js";

const ORG_NAME = "Demo PD";
const JURISDICTION_NAME = "Demo Jurisdiction";
const USERNAME = "demo.investigator";
const EMAIL = "demo.investigator@example.test";
const CASE_NUMBER = "DEMO-CASE-0001";

// Insert if absent (ON CONFLICT DO NOTHING on ANY unique constraint), then
// always re-select by the caller's lookup column -- so this is idempotent
// across reruns regardless of which columns happen to collide.
async function upsertByLookup(table, lookupCol, lookupVal, values) {
  await db.insert(table).values(values).onConflictDoNothing();
  const [row] = await db.select().from(table).where(eq(lookupCol, lookupVal));
  if (!row) throw new Error(`failed to create or find row for ${lookupVal}`);
  return row;
}

async function main() {
  const org = await upsertByLookup(orgs, orgs.name, ORG_NAME, {
    id: randomUUID(),
    name: ORG_NAME,
    description: "Seeded by scripts/dev-seed.mjs for pipeline testing",
  });

  const jurisdiction = await upsertByLookup(jurisdictions, jurisdictions.name, JURISDICTION_NAME, {
    id: randomUUID(),
    name: JURISDICTION_NAME,
    description: "Seeded by scripts/dev-seed.mjs for pipeline testing",
  });

  const user = await upsertByLookup(users, users.username, USERNAME, {
    id: randomUUID(),
    fullName: "Demo Investigator",
    role: "INVESTIGATING_OFFICER",
    orgId: org.id,
    email: EMAIL,
    clearance: "SECRET",
    jurisdictionId: jurisdiction.id,
    status: "ACTIVE",
    username: USERNAME,
    hashedPassword: "seeded-not-a-real-login",
  });

  const caseRow = await upsertByLookup(cases, cases.caseNumber, CASE_NUMBER, {
    id: randomUUID(),
    caseNumber: CASE_NUMBER,
    title: "Document-intelligence pipeline demo case",
    type: "OTHER",
    classification: "RESTRICTED",
    jurisdictionId: jurisdiction.id,
    createdBy: user.id,
  });

  // Same shape POST /auth/login produces: a signed access JWT + its hash
  // registered under access:<sha256(userId)> so requireAuth's Redis check passes.
  const token = signAccessToken({ sub: user.id, username: user.username, role: user.role });
  await redisClient.set(accessTokenKey(user.id), hashAccessToken(token));

  console.log("\n=== document-intelligence test fixtures ready ===");
  console.log("user:", user.id, `(${user.username})`);
  console.log("case:", caseRow.id, `(${caseRow.caseNumber})`);
  console.log(
    "\naccess token (expires with JWT_ACCESS_EXPIRES, default 15m -- rerun this script for a fresh one):",
  );
  console.log(token);
  console.log("\ncopy/paste on the HOST shell you run curl from:");
  console.log(`  export TOKEN="${token}"`);
  console.log(`  export CASE="${caseRow.id}"`);
  console.log(`  export API=http://localhost:3000/api/v1\n`);

  await redisClient.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
