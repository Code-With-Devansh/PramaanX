import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { sha256HexOfStream, decideIntegrity, toCustodyEvents } from "./integrity.js";

// These are the pure helpers behind GET /integrity and GET /custody. The wired
// service functions (DB + storage + ledger) are exercised by the integration
// steps in the plan; here we pin the hashing, the verdict truth table, and the
// custody-flattening independently of any infra.

test("sha256HexOfStream hashes streamed chunks identically to a one-shot digest", async () => {
  const parts = ["hello ", "immutable ", "evidence"];
  const expected = createHash("sha256").update(parts.join("")).digest("hex");
  const got = await sha256HexOfStream(Readable.from(parts));
  assert.equal(got, expected);
});

test("sha256HexOfStream rejects when the underlying stream errors", async () => {
  const boom = new Readable({
    read() {
      this.destroy(new Error("read failed"));
    },
  });
  await assert.rejects(sha256HexOfStream(boom), /read failed/);
});

test("decideIntegrity: anchored and all three hashes agree -> VERIFIED", () => {
  const h = "a".repeat(64);
  assert.deepEqual(
    decideIntegrity({ recomputed: h, dbSha256: h, ledgerHash: h, anchored: true }),
    { status: "VERIFIED", matches: true },
  );
});

test("decideIntegrity: storage bytes diverge from the anchor -> TAMPERED", () => {
  const anchor = "a".repeat(64);
  const tampered = "b".repeat(64);
  assert.deepEqual(
    decideIntegrity({ recomputed: tampered, dbSha256: anchor, ledgerHash: anchor, anchored: true }),
    { status: "TAMPERED", matches: false },
  );
});

test("decideIntegrity: mirror and anchor disagree (only two of three match) -> TAMPERED", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  // recomputed === ledgerHash but the mirror recorded something else.
  assert.deepEqual(
    decideIntegrity({ recomputed: a, dbSha256: b, ledgerHash: a, anchored: true }),
    { status: "TAMPERED", matches: false },
  );
});

test("decideIntegrity: not yet anchored but storage matches the mirror -> PENDING", () => {
  const h = "a".repeat(64);
  assert.deepEqual(
    decideIntegrity({ recomputed: h, dbSha256: h, ledgerHash: null, anchored: false }),
    { status: "PENDING", matches: false },
  );
});

test("decideIntegrity: not yet anchored AND storage diverges from the mirror -> TAMPERED", () => {
  assert.deepEqual(
    decideIntegrity({
      recomputed: "b".repeat(64),
      dbSha256: "a".repeat(64),
      ledgerHash: null,
      anchored: false,
    }),
    { status: "TAMPERED", matches: false },
  );
});

test("decideIntegrity: anchored flag set but no ledger record -> treated as not anchored", () => {
  const h = "a".repeat(64);
  // Defensive: ANCHORED in the mirror but the ledger read returned null.
  assert.deepEqual(
    decideIntegrity({ recomputed: h, dbSha256: h, ledgerHash: null, anchored: true }),
    { status: "PENDING", matches: false },
  );
});

test("toCustodyEvents flattens per-version history into one chronological trail", () => {
  const perVersion = [
    {
      versionNo: 2,
      entries: [
        {
          txId: "tx-seal",
          timestamp: 200,
          isDelete: false,
          value: { lastAction: "SEALED", lastActor: "u2", sha256: "b".repeat(64) },
        },
      ],
    },
    {
      versionNo: 1,
      entries: [
        {
          txId: "tx-reg",
          timestamp: 100,
          isDelete: false,
          value: { lastAction: "REGISTERED", lastActor: "u1", sha256: "a".repeat(64) },
        },
      ],
    },
  ];
  const events = toCustodyEvents(perVersion);
  assert.equal(events.length, 2);
  // Oldest first, regardless of the input version ordering.
  assert.equal(events[0].ledgerTxId, "tx-reg");
  assert.equal(events[0].action, "REGISTERED");
  assert.equal(events[0].actor, "u1");
  assert.equal(events[0].versionNo, 1);
  assert.equal(events[0].hash, "a".repeat(64));
  assert.equal(events[0].timestamp, new Date(100 * 1000).toISOString());
  assert.equal(events[1].ledgerTxId, "tx-seal");
  assert.equal(events[1].versionNo, 2);
  // The internal epoch sort key must not leak into the payload.
  assert.ok(!("ts" in events[0]));
});

test("toCustodyEvents falls back to value.actor when lastActor is absent", () => {
  const [event] = toCustodyEvents([
    {
      versionNo: 1,
      entries: [{ txId: "t", timestamp: 5, isDelete: false, value: { actor: "u9", sha256: null } }],
    },
  ]);
  assert.equal(event.actor, "u9");
  assert.equal(event.action, null);
  assert.equal(event.hash, null);
});

test("toCustodyEvents tolerates empty or missing entries", () => {
  assert.deepEqual(
    toCustodyEvents([
      { versionNo: 1, entries: [] },
      { versionNo: 2, entries: undefined },
    ]),
    [],
  );
});
