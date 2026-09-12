import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { promises as dns } from "node:dns";

// FabricLedgerService — the real @hyperledger/fabric-gateway client behind
// LEDGER_DRIVER=fabric. It implements the exact same 6-method LedgerService seam
// (see ./types.js) as createInMemoryLedgerService, talking to the deployed
// `document` chaincode (fabric/chaincode/document/lib/documentContract.js) on the
// WSL2 test-network. Swapping the stub for this is an env flip, not a code change.
//
// SECURITY: only hashes + lifecycle metadata cross this seam. We send a versionId,
// a sha256, and a storageRef (object-store key) — never document bytes or PII.
//
// Boot-safety: the native deps (@grpc/grpc-js, @hyperledger/fabric-gateway) are
// require()d LAZILY inside createFabricLedgerService, never at module top level.
// src/ledger/index.js imports this file unconditionally, so a "memory"-driver boot
// (api + worker in dev) must not need the Fabric packages installed. Only invoking
// the factory — i.e. LEDGER_DRIVER=fabric — pulls them in.
const require = createRequire(import.meta.url);

// ── pure helpers (no Fabric deps; exported for unit tests) ─────────────────────

const decoder = new TextDecoder();

// Chaincode returns are Uint8Array over the gateway. Normalise to a UTF-8 string;
// tolerate a plain string (tests) and null/empty (the '' GetVersion "not found").
function decodeBytes(bytes) {
  if (bytes == null) return "";
  if (typeof bytes === "string") return bytes;
  return decoder.decode(bytes);
}

// Marshal a RegisterVersionInput into the chaincode's [versionId, payloadJSON]
// argument pair. actorOrg/status/ts are set ON-CHAIN (from the signing cert +
// tx timestamp), never by us, so they are deliberately absent from the payload.
export function marshalRegister(input) {
  const payload = {
    docId: input.docId,
    caseId: input.caseId,
    versionNo: input.versionNo,
    sha256: input.sha256,
    classification: input.classification,
    storageRef: input.storageRef,
    actor: input.actor,
  };
  return [input.versionId, JSON.stringify(payload)];
}

// Parse a chaincode LedgerRecord result. Empty payload -> null (GetVersion returns
// '' for an unknown key; the chaincode maps empty -> "not found").
export function parseRecord(bytes) {
  const text = decodeBytes(bytes);
  if (!text) return null;
  return JSON.parse(text);
}

// A gateway error puts the chaincode's thrown message in .message and/or in the
// per-endorser .details[]. Flatten both so idempotency detection never depends on
// which layer surfaced the string.
function errorHaystack(err) {
  if (!err) return "";
  const parts = [typeof err === "string" ? err : err.message];
  const details = err?.details;
  if (Array.isArray(details)) {
    for (const d of details) parts.push(d?.message);
  }
  return parts.filter(Boolean).join(" ");
}

// The chaincode throws `version <id> is already registered` on a duplicate
// RegisterDocumentVersion. That is idempotent SUCCESS at this seam (a worker retry
// after a post-commit crash), NOT a failure — the adapter catches it and re-reads.
export function isAlreadyRegistered(err) {
  return /is already registered/i.test(errorHaystack(err));
}

// The chaincode throws `version <id> is already SEALED` on a duplicate
// SealDocument. Also idempotent success — a seal that already took effect.
export function isAlreadySealed(err) {
  return /is already SEALED/i.test(errorHaystack(err));
}

// ── the driver ─────────────────────────────────────────────────────────────────

/**
 * Construct a FabricLedgerService bound to one gateway connection. Synchronous:
 * connect() returns immediately and the gRPC client dials lazily on first call,
 * so `export const ledger = buildLedger()` in index.js stays synchronous.
 *
 * @param {{
 *   channel: string, chaincode: string, mspId: string,
 *   peerEndpoint: string, peerHostAlias: string,
 *   tlsRootCertPath: string, signCertPath: string, signKeyPath: string,
 * }} cfg
 * @returns {import("./types.js").LedgerService}
 */

// Resolves a "host:port" endpoint to "ipv4literal:port", using an EXPLICIT
// family:4 lookup rather than the general dual-stack lookup grpc-js's own
// resolver performs — see the long comment inside createFabricLedgerService
// for why the dual-stack path can miss a real, reachable IPv4 address
// entirely on Docker Desktop's WSL2 mirrored network mode. A bare IP
// literal (no hostname to resolve) is returned unchanged.
async function resolveIPv4Endpoint(endpoint) {
  const lastColon = endpoint.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`fabric ledger: invalid endpoint "${endpoint}", expected "host:port"`);
  }
  const host = endpoint.slice(0, lastColon);
  const port = endpoint.slice(lastColon + 1);

  // Already a literal IPv4 address — nothing to resolve.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return endpoint;
  }

  const { address } = await dns.lookup(host, { family: 4 });
  return `${address}:${port}`;
}

export async function createFabricLedgerService(cfg) {
  const grpc = require("@grpc/grpc-js");
  const { connect, signers } = require("@hyperledger/fabric-gateway");

  for (const key of ["tlsRootCertPath", "signCertPath", "signKeyPath"]) {
    if (!cfg?.[key]) {
      throw new Error(`fabric ledger: missing config.ledger.fabric.${key}`);
    }
  }

  // gRPC channel to the peer. The cert SAN is peer0.org1.example.com but in the
  // containerize+bridge model we dial host.docker.internal:7051 — so override the
  // TLS authority (SNI) to the SAN or the handshake fails hostname verification.
  //
  // IMPORTANT: on Docker Desktop's WSL2 "mirrored" network mode,
  // host.docker.internal's DUAL-STACK resolution (dns.lookup(host, {all:true}),
  // which is what grpc-js's resolver uses) returns ONLY an IPv6 ULA address
  // (fdc4:.../8) from the container's /etc/hosts — that address is not
  // actually routable and fails with ENETUNREACH. A real IPv4 address DOES
  // exist and IS reachable, but only surfaces via an explicit IPv4-only
  // lookup (Docker's embedded DNS resolver answers it; the general
  // dual-stack path never returns it, apparently short-circuiting on the
  // /etc/hosts-only IPv6 entry). Confirmed directly against a running
  // container: `getent hosts host.docker.internal` shows only the IPv6
  // address, but `net.connect({family: 4})` to the same hostname succeeds.
  //
  // Reordering results (dns.setDefaultResultOrder) does NOT fix this, since
  // the IPv4 address is never in the result set to begin with — only an
  // explicit family:4 lookup surfaces it. So: resolve the peer/orderer
  // hostname to its real IPv4 literal ourselves, once, at startup, and hand
  // grpc.Client that literal IP directly. TLS verification is unaffected
  // since grpc.ssl_target_name_override below still targets the cert's SAN
  // regardless of which literal address we actually dial.
  const peerAddress = await resolveIPv4Endpoint(cfg.peerEndpoint);

  const tlsRootCert = readFileSync(cfg.tlsRootCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
  const client = new grpc.Client(peerAddress, tlsCredentials, {
    "grpc.ssl_target_name_override": cfg.peerHostAlias,
  });

  // Identity = the signing cert + MSP id; signer = its private key. In dev this is
  // the Org1 (Police) Admin material copied out of the test-network (DEV-ONLY,
  // gitignored). Prod swaps this for a per-user HSM/wallet identity.
  const credentials = readFileSync(cfg.signCertPath);
  const identity = { mspId: cfg.mspId, credentials };
  const privateKey = createPrivateKey(readFileSync(cfg.signKeyPath));
  const signer = signers.newPrivateKeySigner(privateKey);

  // Per-call deadlines so an unreachable ledger fails fast (surfaced as a retryable
  // error to the anchor worker) instead of hanging the request/job indefinitely.
  const gateway = connect({
    client,
    identity,
    signer,
    evaluateOptions: () => ({ deadline: Date.now() + 15_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 30_000 }),
    submitOptions: () => ({ deadline: Date.now() + 15_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });

  const contract = gateway.getNetwork(cfg.channel).getContract(cfg.chaincode);

  // ── reads (evaluate) ─────────────────────────────────────────────────────────

  async function verifyHash(versionId, sha256) {
    const bytes = await contract.evaluateTransaction("VerifyHash", versionId, sha256);
    const parsed = JSON.parse(decodeBytes(bytes));
    return { match: !!parsed.match, record: parsed.record ?? null };
  }

  async function getVersion(versionId) {
    const bytes = await contract.evaluateTransaction("GetVersion", versionId);
    return parseRecord(bytes); // '' -> null
  }

  async function getDocumentHistory(versionId) {
    const bytes = await contract.evaluateTransaction("GetDocumentHistory", versionId);
    const text = decodeBytes(bytes);
    return text ? JSON.parse(text) : [];
  }

  // ── writes (submit) ──────────────────────────────────────────────────────────

  // Submit via submitAsync so we can capture the real Fabric transaction id (the
  // mirror's ledger_tx_id) alongside the endorsed result. submitAsync endorses,
  // broadcasts to the orderer, and returns; getStatus() then awaits the commit into
  // a block. A chaincode error surfaces here (rejected endorsement), so callers'
  // try/catch see it for idempotency handling.
  async function submitTx(name, args) {
    const commit = await contract.submitAsync(name, { arguments: args });
    const resultBytes = commit.getResult();
    const txId = commit.getTransactionId();
    const status = await commit.getStatus();
    if (!status.successful) {
      throw new Error(`fabric tx ${txId} failed to commit (status code ${status.code})`);
    }
    return { txId, resultBytes };
  }

  // Recover the original register tx (id + record) from the immutable history when
  // a version is "already registered". getHistoryForKey returns entries oldest-
  // first, so the REGISTERED entry carries the true register txId + its record.ts —
  // exactly what the anchor worker mirrors. Without this the idempotent path would
  // have no txId to stamp.
  async function readRegisterTx(versionId) {
    const history = await getDocumentHistory(versionId);
    const entry = history.find((h) => h.value?.lastAction === "REGISTERED") ?? history[0];
    const record = entry?.value ?? (await getVersion(versionId));
    return { txId: entry?.txId, record };
  }

  async function registerDocumentVersion(input) {
    const args = marshalRegister(input);
    try {
      const { txId, resultBytes } = await submitTx("RegisterDocumentVersion", args);
      return { txId, record: parseRecord(resultBytes), alreadyRegistered: false };
    } catch (err) {
      if (!isAlreadyRegistered(err)) throw err;
      const { txId, record } = await readRegisterTx(input.versionId);
      return { txId, record, alreadyRegistered: true };
    }
  }

  async function recordCustodyEvent(versionId, event) {
    const payload = { action: event?.action, actor: event?.actor };
    if (event?.note) payload.note = event.note;
    const { txId, resultBytes } = await submitTx("RecordCustodyEvent", [
      versionId,
      JSON.stringify(payload),
    ]);
    return { txId, record: parseRecord(resultBytes) };
  }

  async function sealDocument(versionId, actor) {
    try {
      const { txId, resultBytes } = await submitTx("SealDocument", [versionId, actor]);
      return { txId, record: parseRecord(resultBytes) };
    } catch (err) {
      // Idempotent: a version already SEALED is success, not failure. Recover the
      // seal tx from history (newest SEALED entry) so the mirror still reconciles.
      if (!isAlreadySealed(err)) throw err;
      const history = await getDocumentHistory(versionId);
      const entry = [...history].reverse().find((h) => h.value?.status === "SEALED");
      const record = entry?.value ?? (await getVersion(versionId));
      return { txId: entry?.txId, record };
    }
  }

  async function close() {
    // Release the gateway then the underlying gRPC channel.
    gateway.close();
    client.close();
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
