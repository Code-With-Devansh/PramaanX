import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLedgerAnchorProcessor,
  createAnchorFailureHandler,
} from "./ledgerAnchor.processor.js";
// Import the plain-string action/target constants directly — NOT via
// ../audit/index.js, which transitively boots the pg pool (process.exit without
// DATABASE_URL). The processor only needs the label maps.
import { AuditAction, TargetType } from "../audit/actions.js";

// Minimal fakes: a fake db whose transaction() just runs the callback with a
// sentinel tx, a fake repo capturing its calls, and a capturing recordAudit.
function makeDeps({ ledger }) {
  const calls = { anchored: [], failed: [], audits: [] };
  const TX = Symbol("tx");
  const db = { transaction: (cb) => cb(TX) };
  const repo = {
    setLedgerAnchored: async (tx, args) => {
      assert.equal(tx, TX, "repo write must run inside the injected transaction");
      calls.anchored.push(args);
    },
    setLedgerFailed: async (tx, args) => {
      assert.equal(tx, TX);
      calls.failed.push(args);
    },
  };
  const recordAudit = async (tx, entry) => {
    assert.equal(tx, TX, "audit must run inside the same transaction");
    calls.audits.push(entry);
  };
  const deps = { ledger, repo, db, recordAudit, AuditAction, TargetType };
  return { deps, calls };
}

const job = () => ({
  id: "v-1",
  data: {
    versionId: "v-1",
    docId: "d-1",
    caseId: "c-1",
    versionNo: 3,
    sha256: "a".repeat(64),
    classification: "CONFIDENTIAL",
    storageRef: "cases/c-1/d-1/v-1",
    actor: "user-1",
  },
});

test("processor anchors: writes ANCHORED + txId + anchoredAt and a VERSION_ANCHORED audit", async () => {
  const ledger = {
    registerDocumentVersion: async (data) => {
      assert.equal(data.versionId, "v-1");
      return { txId: "mem_deadbeef", record: { ts: 1_700_000_000, actorOrg: "MEMORY" } };
    },
  };
  const { deps, calls } = makeDeps({ ledger });
  const process = createLedgerAnchorProcessor(deps);

  const result = await process(job());

  assert.deepEqual(result, { versionId: "v-1", txId: "mem_deadbeef" });
  assert.equal(calls.anchored.length, 1);
  assert.deepEqual(calls.anchored[0], {
    versionId: "v-1",
    ledgerTxId: "mem_deadbeef",
    // epoch seconds -> Date
    anchoredAt: new Date(1_700_000_000 * 1000),
  });
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].action, AuditAction.VERSION_ANCHORED);
  assert.equal(calls.audits[0].targetType, TargetType.VERSION);
  assert.equal(calls.audits[0].targetId, "v-1");
  assert.equal(calls.audits[0].details.ledgerTxId, "mem_deadbeef");
  assert.equal(calls.audits[0].details.actorOrg, "MEMORY");
});

test("processor propagates a ledger error (so BullMQ retries) and does NOT write ANCHORED", async () => {
  const ledger = {
    registerDocumentVersion: async () => {
      throw new Error("ledger unreachable");
    },
  };
  const { deps, calls } = makeDeps({ ledger });
  const process = createLedgerAnchorProcessor(deps);

  await assert.rejects(() => process(job()), /ledger unreachable/);
  assert.equal(calls.anchored.length, 0, "must not mirror ANCHORED on failure");
  assert.equal(calls.audits.length, 0);
});

test("failure handler flips the row to FAILED and writes a VERSION_ANCHOR_FAILED audit", async () => {
  const { deps, calls } = makeDeps({ ledger: {} });
  const markAnchorFailed = createAnchorFailureHandler(deps);

  await markAnchorFailed(job(), new Error("gave up after retries"));

  assert.deepEqual(calls.failed, [{ versionId: "v-1" }]);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].action, AuditAction.VERSION_ANCHOR_FAILED);
  assert.equal(calls.audits[0].targetId, "v-1");
  assert.match(calls.audits[0].details.reason, /gave up after retries/);
});
