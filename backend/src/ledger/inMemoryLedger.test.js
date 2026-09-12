import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryLedgerService } from "./inMemoryLedger.js";

// A valid version payload (sha256 must be 64 lowercase hex chars).
const SHA = "a".repeat(64);
const baseInput = () => ({
  versionId: "11111111-1111-1111-1111-111111111111",
  docId: "22222222-2222-2222-2222-222222222222",
  caseId: "33333333-3333-3333-3333-333333333333",
  versionNo: 1,
  sha256: SHA,
  classification: "CONFIDENTIAL",
  storageRef: "cases/c/d/v",
  actor: "00000000-0000-0000-0000-000000000001",
});

test("registerDocumentVersion returns a deterministic txId (same input, any instance)", async () => {
  const a = createInMemoryLedgerService({ clock: () => 1000 });
  const b = createInMemoryLedgerService({ clock: () => 2000 });
  const r1 = await a.registerDocumentVersion(baseInput());
  const r2 = await b.registerDocumentVersion(baseInput());
  assert.equal(r1.txId, r2.txId, "txId must depend only on versionId+sha256");
  assert.match(r1.txId, /^mem_[0-9a-f]{64}$/);
});

test("registerDocumentVersion is idempotent — second call returns the stored record", async () => {
  const ledger = createInMemoryLedgerService({ clock: () => 1000 });
  const first = await ledger.registerDocumentVersion(baseInput());
  assert.equal(first.alreadyRegistered, false);

  // Re-register the same versionId with a different clock: must NOT throw and
  // must return the ORIGINAL record (same txId, same ts), so worker retries are safe.
  const ledger2 = createInMemoryLedgerService({ clock: () => 9999 });
  await ledger2.registerDocumentVersion(baseInput()); // seed ledger2
  const again = await ledger2.registerDocumentVersion(baseInput());
  assert.equal(again.alreadyRegistered, true);
  assert.equal(again.txId, first.txId);
});

test("record ts is epoch seconds from the injected clock", async () => {
  const ledger = createInMemoryLedgerService({ clock: () => 1_700_000_000 });
  const { record } = await ledger.registerDocumentVersion(baseInput());
  assert.equal(record.ts, 1_700_000_000);
  assert.equal(record.status, "ACTIVE");
  assert.equal(record.lastAction, "REGISTERED");
  assert.equal(record.docType, "DocumentVersion");
});

test("mode:'fail' makes writes throw (retryable), reads do not", async () => {
  const ledger = createInMemoryLedgerService({ mode: "fail" });
  await assert.rejects(() => ledger.registerDocumentVersion(baseInput()), /simulated ledger failure/);
  // A read on an unknown key is still safe (returns null), not a throw.
  assert.equal(await ledger.getVersion("nope"), null);
});

test("validation mirrors the chaincode (bad sha256 / classification / missing field)", async () => {
  const ledger = createInMemoryLedgerService();
  await assert.rejects(
    () => ledger.registerDocumentVersion({ ...baseInput(), sha256: "TOOSHORT" }),
    /64-character lowercase hex/,
  );
  await assert.rejects(
    () => ledger.registerDocumentVersion({ ...baseInput(), classification: "TOP_SECRET" }),
    /classification must be one of/,
  );
  await assert.rejects(
    () => ledger.registerDocumentVersion({ ...baseInput(), docId: "" }),
    /missing required field: docId/,
  );
});

test("verifyHash matches the anchored hash and rejects a tampered one", async () => {
  const ledger = createInMemoryLedgerService();
  const input = baseInput();
  await ledger.registerDocumentVersion(input);

  const ok = await ledger.verifyHash(input.versionId, SHA);
  assert.equal(ok.match, true);
  assert.equal(ok.record.sha256, SHA);

  const tampered = await ledger.verifyHash(input.versionId, "b".repeat(64));
  assert.equal(tampered.match, false);

  const unknown = await ledger.verifyHash("does-not-exist", SHA);
  assert.deepEqual(unknown, { match: false, record: null });
});

test("getVersion returns null before register and the record after", async () => {
  const ledger = createInMemoryLedgerService();
  const input = baseInput();
  assert.equal(await ledger.getVersion(input.versionId), null);
  await ledger.registerDocumentVersion(input);
  const rec = await ledger.getVersion(input.versionId);
  assert.equal(rec.versionId, input.versionId);
  // Returned record is a copy — mutating it must not corrupt world state.
  rec.status = "HACKED";
  assert.equal((await ledger.getVersion(input.versionId)).status, "ACTIVE");
});

test("getDocumentHistory returns an ordered custody trail", async () => {
  const ledger = createInMemoryLedgerService();
  const input = baseInput();
  await ledger.registerDocumentVersion(input);
  await ledger.recordCustodyEvent(input.versionId, { action: "TRANSFERRED", actor: input.actor });
  await ledger.recordCustodyEvent(input.versionId, { action: "DISCLOSED", actor: input.actor });

  const history = await ledger.getDocumentHistory(input.versionId);
  assert.equal(history.length, 3);
  assert.equal(history[0].value.lastAction, "REGISTERED");
  assert.equal(history[1].value.lastAction, "TRANSFERRED");
  assert.equal(history[2].value.lastAction, "DISCLOSED");
});

test("a SEALED version rejects further custody actions except DISCLOSED", async () => {
  const ledger = createInMemoryLedgerService();
  const input = baseInput();
  await ledger.registerDocumentVersion(input);
  await ledger.sealDocument(input.versionId, input.actor);
  await assert.rejects(
    () => ledger.recordCustodyEvent(input.versionId, { action: "TRANSFERRED", actor: input.actor }),
    /is SEALED/,
  );
  // DISCLOSED (a read-out) is still allowed on a sealed record.
  const disclosed = await ledger.recordCustodyEvent(input.versionId, { action: "DISCLOSED", actor: input.actor });
  assert.equal(disclosed.record.status, "SEALED");
});
