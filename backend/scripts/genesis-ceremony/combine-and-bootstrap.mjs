#!/usr/bin/env node
// Genesis ceremony CLI — the one-time bootstrap of the governance hierarchy.
//
// Reads a roster/pools JSON descriptor and the (out-of-band reconstructed)
// founding secret, then POSTs them to /api/v1/governance/bootstrap. The server
// gates the call on sha256(secret) === GOVERNANCE_GENESIS_COMMITMENT and on
// admin_pools being empty, so this is safe to run exactly once — subsequent
// runs get a 409 (self-disabled).
//
// SCOPE: this is the "combine-and-bootstrap" entry point. Actual Shamir
// share-combining (reconstructing the secret from k custodian shares) is part
// of the deferred fire-drill tooling; here the operator supplies the already
// reconstructed secret via --secret-file or the GENESIS_SECRET env var. The
// secret is NEVER accepted on argv (it would leak into shell history / ps).
//
// Usage:
//   GENESIS_SECRET=... node scripts/genesis-ceremony/combine-and-bootstrap.mjs \
//     --roster scripts/genesis-ceremony/roster.example.json
//   node scripts/genesis-ceremony/combine-and-bootstrap.mjs \
//     --roster ./roster.json --secret-file ./secret.txt --url http://localhost:3000
//
// Options:
//   --roster <path>       (required) JSON: { roster:[...], pools:[...], shares?:[...] }
//   --secret-file <path>  read the founding secret from this file (trailing newline trimmed)
//   --url <baseUrl>       API base URL (default $DMS_API_URL or http://localhost:3000)
//   -h, --help            print this help

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const HELP = `genesis-ceremony bootstrap

  --roster <path>       (required) JSON descriptor: { roster, pools, shares? }
  --secret-file <path>  read the founding secret from a file (or set GENESIS_SECRET)
  --url <baseUrl>       API base URL (default $DMS_API_URL or http://localhost:3000)
  -h, --help            show this help

The secret is read from GENESIS_SECRET or --secret-file only, never from argv.`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        roster: { type: "string" },
        "secret-file": { type: "string" },
        url: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values } = parsed;

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.roster) fail("--roster <path> is required (see --help)");

  // Secret: env var wins, else --secret-file. Trim trailing newlines an editor
  // may have added; anything else is treated as part of the secret.
  let secret = process.env.GENESIS_SECRET ?? "";
  if (!secret && values["secret-file"]) {
    secret = (await readFile(values["secret-file"], "utf8")).replace(/\r?\n+$/, "");
  }
  if (!secret) {
    fail("no secret: set GENESIS_SECRET or pass --secret-file <path>");
  }

  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(values.roster, "utf8"));
  } catch (err) {
    fail(`could not read/parse --roster ${values.roster}: ${err.message}`);
  }

  const { roster, pools, shares } = descriptor;
  if (!Array.isArray(roster) || !Array.isArray(pools)) {
    fail("roster JSON must contain `roster` and `pools` arrays");
  }

  const base = (values.url ?? process.env.DMS_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const endpoint = `${base}/api/v1/governance/bootstrap`;
  const body = { secret, roster, pools, ...(shares ? { shares } : {}) };

  console.log(`→ POST ${endpoint}`);
  console.log(`  roster: ${roster.length} user(s), pools: ${pools.length}, shares: ${shares?.length ?? 0}`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    fail(`request failed (is the API up at ${base}?): ${err.message}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!res.ok) {
    console.error(`\n✗ bootstrap rejected (HTTP ${res.status}):`);
    console.error(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    // 409/403 here usually means governance is already bootstrapped, or the
    // secret does not match GOVERNANCE_GENESIS_COMMITMENT — both are expected
    // guardrails, not bugs.
    process.exit(1);
  }

  console.log("\n✓ genesis written. Governance is now live.");
  console.log(JSON.stringify(payload, null, 2));
  console.log(
    "\nReminder: the founding secret and any Shamir shares must NOT be stored on the server.\n" +
      "Distribute shares to custodians and destroy this machine's copy of the secret.",
  );
}

main().catch((err) => fail(err?.stack ?? String(err)));
