import { createHash } from "node:crypto";

// InMemoryLedgerService — a faithful, dependency-free stand-in for the Fabric
// `document` chaincode (fabric/chaincode/document/lib/documentContract.js). It
// lets the whole anchor pipeline run and be tested without Fabric, WSL, or a
// gateway client in the container. A FabricLedgerService implementing the same
// LedgerService seam (see ./types.js) drops in later behind LEDGER_DRIVER=fabric.
//
// Fidelity to the chaincode (so it's a real test double, not a happy-path fake):
//   - same field validation (sha256 shape, classification vocabulary)
//   - same idempotency: a versionId registers once
//   - same record shape and the same SEALED/LEGAL_HOLD custody rules
//   - `ts` is epoch SECONDS, matching getTxTimestamp().seconds
// It intentionally does NOT model MSP identity — actorOrg is a fixed sentinel, so
// nothing mistakes a stub record for a real cryptographic attestation.

const CLASSIFICATIONS = ["PUBLIC", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
const CUSTODY_ACTIONS = ["SIGNED", "TRANSFERRED", "SEALED", "LEGAL_HOLD", "DISCLOSED", "RESTORED"];

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// Deterministic stand-in for a Fabric transaction id. The same (versionId,
// sha256) always yields the same id, so a worker retry that re-anchors a version
// is idempotent and never produces a second, conflicting ledger_tx_id.
function deterministicTxId(versionId, sha256) {
  return "mem_" + sha256Hex(`${versionId}:${sha256}`);
}

function requireField(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing required field: ${name}`);
  }
  return value;
}

/**
 * @param {{ mode?: string, actorOrg?: string, clock?: () => number }} [opts]
 *   mode="fail" makes every write throw (to exercise the retry -> FAILED path);
 *   actorOrg is the sentinel org stamped on records; clock overrides the epoch-
 *   seconds source (tests inject a fixed clock for determinism).
 * @returns {import("./types.js").LedgerService}
 */
export function createInMemoryLedgerService({ mode = "ok", actorOrg = "MEMORY", clock } = {}) {
  // versionId -> { txId, record }. Stands in for world state.
  const state = new Map();
  // versionId -> HistoryEntry[]; every write appends, mirroring getHistoryForKey.
  const history = new Map();

  const nowSeconds = () =>
    typeof clock === "function" ? clock() : Math.floor(Date.now() / 1000);

  // Simulates an unreachable / erroring ledger. This is a RETRYABLE transport
  // failure — distinct from the idempotent "already registered" success path,
  // which must NOT throw at this seam.
  function failIfConfigured() {
    if (mode === "fail") {
      throw new Error("[inMemoryLedger] simulated ledger failure (LEDGER_STUB_MODE=fail)");
    }
  }

  function appendHistory(versionId, txId, record) {
    const entries = history.get(versionId) ?? [];
    // Snapshot the record so later mutations don't rewrite past history entries.
    entries.push({ txId, timestamp: record.ts, isDelete: false, value: { ...record } });
    history.set(versionId, entries);
  }

  async function registerDocumentVersion(input) {
    failIfConfigured();
    const versionId = requireField("versionId", input.versionId);

    // Idempotent success: re-registering a known version returns the stored
    // record + txId instead of throwing (the chaincode throws; the FabricLedger
    // adapter catches "already registered" and re-reads — the stub short-circuits).
    const existing = state.get(versionId);
    if (existing) {
      return { txId: existing.txId, record: { ...existing.record }, alreadyRegistered: true };
    }

    requireField("docId", input.docId);
    requireField("caseId", input.caseId);
    requireField("sha256", input.sha256);
    requireField("storageRef", input.storageRef);
    requireField("actor", input.actor);
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new Error("sha256 must be a 64-character lowercase hex string");
    }
    if (!CLASSIFICATIONS.includes(input.classification)) {
      throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(", ")}`);
    }

    const txId = deterministicTxId(versionId, input.sha256);
    const record = {
      docType: "DocumentVersion",
      versionId,
      docId: input.docId,
      caseId: input.caseId,
      versionNo: Number.isFinite(Number(input.versionNo)) ? Number(input.versionNo) : 0,
      sha256: input.sha256,
      classification: input.classification,
      storageRef: input.storageRef,
      actor: input.actor,
      actorOrg,
      status: "ACTIVE",
      lastAction: "REGISTERED",
      lastActor: input.actor,
      ts: nowSeconds(),
    };

    state.set(versionId, { txId, record });
    appendHistory(versionId, txId, record);
    return { txId, record: { ...record }, alreadyRegistered: false };
  }

  async function recordCustodyEvent(versionId, event) {
    failIfConfigured();
    const stored = state.get(versionId);
    if (!stored) throw new Error(`version ${versionId} not found`);

    requireField("action", event?.action);
    requireField("actor", event?.actor);
    if (!CUSTODY_ACTIONS.includes(event.action)) {
      throw new Error(`action must be one of: ${CUSTODY_ACTIONS.join(", ")}`);
    }
    // A sealed record is frozen; only DISCLOSED (a read-out) may still be logged.
    if (stored.record.status === "SEALED" && event.action !== "DISCLOSED") {
      throw new Error(`version ${versionId} is SEALED; action ${event.action} is not permitted`);
    }

    const record = stored.record;
    if (event.action === "SEALED") record.status = "SEALED";
    if (event.action === "LEGAL_HOLD") record.status = "LEGAL_HOLD";
    record.lastAction = event.action;
    record.lastActor = event.actor;
    if (event.note) record.lastNote = event.note;
    record.ts = nowSeconds();

    const txId = deterministicTxId(versionId, `${event.action}:${(history.get(versionId)?.length ?? 0)}`);
    appendHistory(versionId, txId, record);
    return { txId, record: { ...record } };
  }

  async function sealDocument(versionId, actor) {
    failIfConfigured();
    requireField("actor", actor);
    const stored = state.get(versionId);
    if (!stored) throw new Error(`version ${versionId} not found`);
    if (stored.record.status === "SEALED") {
      throw new Error(`version ${versionId} is already SEALED`);
    }

    const record = stored.record;
    record.status = "SEALED";
    record.lastAction = "SEALED";
    record.lastActor = actor;
    record.ts = nowSeconds();

    const txId = deterministicTxId(versionId, `SEALED:${(history.get(versionId)?.length ?? 0)}`);
    appendHistory(versionId, txId, record);
    return { txId, record: { ...record } };
  }

  async function verifyHash(versionId, sha256) {
    const stored = state.get(versionId);
    if (!stored) return { match: false, record: null };
    return { match: stored.record.sha256 === sha256, record: { ...stored.record } };
  }

  async function getVersion(versionId) {
    const stored = state.get(versionId);
    return stored ? { ...stored.record } : null;
  }

  async function getDocumentHistory(versionId) {
    const entries = history.get(versionId) ?? [];
    // Return copies so callers can't mutate the recorded trail.
    return entries.map((e) => ({ ...e, value: e.value ? { ...e.value } : null }));
  }

  async function close() {
    // No connection to release; present so callers can await ledger.close?.()
    // uniformly across the memory and fabric drivers.
  }

  return {
    registerDocumentVersion,
    recordCustodyEvent,
    sealDocument,
    verifyHash,
    getVersion,
    getDocumentHistory,
    close,
  };
}
