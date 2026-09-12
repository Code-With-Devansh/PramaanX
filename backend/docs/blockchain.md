# Blockchain Layer — Handoff & Deep Guide (Hyperledger Fabric)

> **Audience:** the team member owning the blockchain / integrity layer.
> **Goal:** everything you need to build the Fabric network, the smart contract (chaincode),
> and the integration the backend calls — without having to reverse-engineer the rest of the project.
> **Read alongside:** `DESIGN.md` (whole system) and `contract.md` (REST API).
>
> This document supersedes the earlier conversational notes in this file.

---

## Table of Contents
1. [What you're building & why](#1-what-youre-building--why)
2. [The one mental model (read twice)](#2-the-one-mental-model-read-twice)
3. [Your scope vs the backend team's scope](#3-your-scope-vs-the-backend-teams-scope)
4. [The integration contract (most important section)](#4-the-integration-contract-most-important-section)
5. [Environment setup (Windows → WSL2)](#5-environment-setup-windows--wsl2)
6. [Network topology](#6-network-topology)
7. [On-chain vs off-chain data](#7-on-chain-vs-off-chain-data)
8. [The chaincode (smart contract)](#8-the-chaincode-smart-contract)
9. [Chaincode lifecycle (deploy/upgrade)](#9-chaincode-lifecycle-deployupgrade)
10. [Identity model](#10-identity-model)
11. [Express ↔ Fabric integration](#11-express--fabric-integration)
12. [Private Data Collections (confidentiality)](#12-private-data-collections-confidentiality)
13. [Task checklist & phasing](#13-task-checklist--phasing)
14. [Testing & the demo](#14-testing--the-demo)
15. [Pitfalls & honest time budget](#15-pitfalls--honest-time-budget)
16. [Glossary](#16-glossary)
17. [References](#17-references)
18. [Definition of Done](#18-definition-of-done)

---

## 1. What you're building & why

We're building a **Secure Legal & Investigation Document Management System** for law enforcement,
courts, and forensics. Documents (FIRs, chargesheets, forensic reports, etc.) must be **tamper-proof
and provably auditable** — that's what makes them hold up as evidence.

**Your job:** provide the integrity backbone using **Hyperledger Fabric**, a *permissioned* blockchain.

**Why Fabric (not Ethereum/a public chain):**
- **Permissioned & private** — only known agencies (Police, Court, Forensics) run nodes. No gas, no public exposure of law-enforcement data.
- **Multi-org immutability** — no single agency (or admin) can silently rewrite history; that's the core evidentiary property.
- **Fabric-native features we exploit directly:**
  1. `getHistoryForKey` → an instant, tamper-proof **chain-of-custody report** (you query it, you don't build it).
  2. **Endorsement policies** → encode law into the ledger (e.g., *"a document can't be sealed unless the Court co-signs"*).
  3. **Private Data Collections** → confidential-but-auditable data (needed for classification / need-to-know).

**Honest expectation:** roughly **40% of your effort is network/identity plumbing**, not writing
chaincode. This guide flags exactly where, so you can budget for it.

---

## 2. The one mental model (read twice)

> **The Fabric ledger is the source of truth for integrity & custody.**
> **PostgreSQL is a fast read-mirror, kept in sync by listening to Fabric commit events.**

```
   React SPA
      │ HTTPS
┌─────▼──────────────────────────────────────────────┐
│              Express API (TypeScript)                │
│  authZ · validation · services                       │
└───┬───────────────┬──────────────────┬──────────────┘
    │               │                  │
┌───▼────┐   ┌──────▼──────┐   ┌────────▼─────────────┐
│Postgres│   │ MinIO/S3     │   │ Fabric Gateway SDK    │
│(mirror │   │ encrypted    │   │ submit / evaluate     │
│ + fast │   │ documents    │   └────────┬─────────────┘
│ search)│   └──────────────┘            │
└───▲────┘                     ┌─────────▼──────────────────────┐
    │  chaincode-event          │   Hyperledger Fabric network    │
    │  listener  ◄──────────────┤  Police │ Court │ Forensics     │
    │  (CQRS sync)              │  peers · orderer(Raft) · CA · CC │
    └── keeps Postgres in sync  └─────────────────────────────────┘
```

Two rules that follow from this model — **never break them:**
- **On-chain = hashes + lifecycle events only.** The document bytes and PII **never** touch the ledger.
- **Don't mark anything "done" in Postgres until the chaincode transaction actually committed.**
  This avoids the dual-write problem (DB says success, ledger didn't commit). The commit **event** is your signal to update Postgres.

---

## 3. Your scope vs the backend team's scope

| You own (blockchain) | Backend team owns |
|---|---|
| Fabric network (orgs, peers, orderer, CAs, channel) | Express API, routes, authZ (RBAC/ABAC) |
| Chaincode (the smart contract) + its lifecycle | Document upload flow, MinIO storage, SHA-256 hashing |
| The `LedgerService` module Express imports | Calling `LedgerService` at the right moments |
| The chaincode-event → Postgres sync worker | Postgres schema & the mirror columns you write to |
| Fabric identities/CA enrollment, connection config | User auth, sessions, MFA |

**The boundary between you two is the `LedgerService` interface in §4.** Nail that down first,
then you can both work in parallel — they build against a fake implementation while you build the
real Fabric one behind the same interface.

---

## 4. The integration contract (MOST IMPORTANT SECTION)

Deliver a single module — `LedgerService` — that Express imports. Everything Fabric-specific
(gateway, identities, connection profiles, chaincode names) lives **behind** this interface, so the
backend never imports Fabric SDK types directly.

### 4.1 The on-chain record (world-state value)
Keyed by `versionId` (which **equals** `document_versions.id` in Postgres — that's the join):

```ts
interface LedgerRecord {
  docType: 'DocumentVersion';
  versionId: string;      // == Postgres document_versions.id
  docId: string;
  caseId: string;
  versionNo: number;
  sha256: string;         // hash of the file bytes (computed by backend at upload)
  classification: 'PUBLIC' | 'RESTRICTED' | 'CONFIDENTIAL' | 'SECRET';
  storageRef: string;     // OPAQUE pointer to MinIO object (not the file, not a URL with secrets)
  actor: string;          // badge/user id of who caused this
  actorOrg: string;       // MSP id of submitting org (set by chaincode, not the caller)
  status: 'ACTIVE' | 'SUPERSEDED' | 'SEALED' | 'LEGAL_HOLD';
  ts: number;             // Fabric tx timestamp (deterministic — NOT Date.now())
}
```

### 4.2 The TypeScript interface you deliver
```ts
export interface RegisterVersionInput {
  versionId: string; docId: string; caseId: string; versionNo: number;
  sha256: string; classification: LedgerRecord['classification'];
  storageRef: string; actor: string;
}
export interface CustodyEventInput {
  action: 'SIGNED' | 'TRANSFERRED' | 'SEALED' | 'LEGAL_HOLD' | 'DISCLOSED' | 'RESTORED';
  actor: string; note?: string;
}
export interface CustodyEntry {
  txId: string; timestamp: number; action: string; actor: string; value: LedgerRecord;
}

export interface LedgerService {
  // WRITES (submitTransaction — waits for consensus, ~1–2s; call from a BullMQ job, not inline)
  registerDocumentVersion(input: RegisterVersionInput): Promise<{ txId: string }>;
  recordCustodyEvent(versionId: string, event: CustodyEventInput): Promise<{ txId: string }>;
  sealDocument(versionId: string, actor: string): Promise<{ txId: string }>; // needs Police AND Court endorsement

  // READS (evaluateTransaction — fast, no consensus)
  verifyHash(versionId: string, sha256: string): Promise<{ match: boolean; record: LedgerRecord | null }>;
  getVersion(versionId: string): Promise<LedgerRecord | null>;
  getDocumentHistory(versionId: string): Promise<CustodyEntry[]>; // the chain-of-custody
}
```

### 4.3 Give the backend a fake implementation on day one
So they aren't blocked while Fabric comes up. Ship this stub first, same interface:
```ts
// InMemoryLedgerService — swap for FabricLedgerService later. No behavior change for callers.
export class InMemoryLedgerService implements LedgerService {
  private store = new Map<string, LedgerRecord>();
  private history = new Map<string, CustodyEntry[]>();
  async registerDocumentVersion(i: RegisterVersionInput) {
    const rec: LedgerRecord = { ...i, docType: 'DocumentVersion', actorOrg: 'PoliceMSP', status: 'ACTIVE', ts: 0 };
    this.store.set(i.versionId, rec);
    const txId = 'fake-' + i.versionId;
    this.history.set(i.versionId, [{ txId, timestamp: 0, action: 'REGISTERED', actor: i.actor, value: rec }]);
    return { txId };
  }
  async verifyHash(id: string, sha256: string) {
    const record = this.store.get(id) ?? null;
    return { match: !!record && record.sha256 === sha256, record };
  }
  // ...implement the rest similarly
}
```

### 4.4 Postgres mirror columns the backend must add
Coordinate this with whoever owns the schema (ties into the version-control work already underway):
`document_versions.ledger_status` (`PENDING_LEDGER | ANCHORED | FAILED`),
`document_versions.ledger_tx_id`, `document_versions.anchored_at`.

---

## 5. Environment setup (Windows → WSL2)

**Do this before anything else. Native Windows Fabric development is painful; WSL2 is the smooth, supported path.**

1. **Install WSL2 + Ubuntu:** in PowerShell (admin): `wsl --install -d Ubuntu`. Reboot.
2. **Install Docker Desktop** and enable **Settings → Resources → WSL Integration** for your Ubuntu distro. Give it **≥ 8 GB RAM** (Fabric is Docker-heavy).
3. **Inside WSL Ubuntu**, install prerequisites:
   ```bash
   sudo apt update && sudo apt install -y git curl jq build-essential
   # Node 20 LTS (via nvm)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
   nvm install 20
   ```
4. **Get Fabric (2.5 LTS) samples, binaries, and Docker images:**
   ```bash
   mkdir -p ~/fabric && cd ~/fabric
   curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh | bash -s -- --fabric-version 2.5.x
   # this creates ./fabric-samples with test-network, binaries in ./bin, and pulls docker images
   ```
5. **Keep the whole project inside the WSL filesystem** (e.g., `~/fabric/...`), **not** under `/mnt/c/...` — cross-filesystem I/O is slow and causes permission headaches.
6. **Smoke test the sample network:**
   ```bash
   cd ~/fabric/fabric-samples/test-network
   ./network.sh up createChannel -c legal-channel -ca   # -ca = use Fabric CAs (we want this)
   ./network.sh down                                     # tear it down
   ```
   If that runs cleanly, your environment is good. **This is the milestone for Day 1.**

---

## 6. Network topology

- **Orgs (MSPs):** `PoliceMSP`, `CourtMSP`, `ForensicsMSP` (add `ProsecutionMSP` later). Each org = 1–2 peers + a Fabric **CA**.
- **Ordering service:** Raft; 1 orderer for dev, 3+ for a realistic setup.
- **Channel:** `legal-channel` (all orgs). Per-jurisdiction channels can come later.
- **Endorsement policies** (this is where you encode law into the ledger):
  - Cheap for creation: `OR('PoliceMSP.member')`
  - Strict for sealing: `AND('PoliceMSP.member','CourtMSP.member')` — a document literally **cannot be sealed** without the Court's peer endorsing. Great pitch point.

**Don't hand-build the network.** Start from `fabric-samples/test-network` (2 orgs, Docker Compose),
treat Org1→Police and Org2→Court, and grow. Adding Forensics as a 3rd org is a later phase.

---

## 7. On-chain vs off-chain data

| On-chain (world state + immutable history) | Off-chain |
|---|---|
| SHA-256 of each document version | The document bytes (MinIO, encrypted) |
| caseId, docType, classification, `storageRef` (opaque pointer) | Full metadata, OCR text, entities (Postgres) |
| Lifecycle events: created, signed, transferred, sealed, legal-hold, disclosed, restored | Routine **view/download** logs (Postgres hash-chained audit — too high-volume for the ledger) |
| actor id/badge + submitting org (MSP) + tx timestamp | **PII / personal data — NEVER on-chain** ("right to erasure") |

**Rule of thumb:** high-value lifecycle events on the ledger; routine reads in Postgres. Putting
every file *view* on-chain wrecks performance and adds no evidentiary value.

---

## 8. The chaincode (smart contract)

Language: **Node.js** (`fabric-contract-api`) — matches the project's JS/TS stack.

```js
// document-contract.js
'use strict';
const { Contract } = require('fabric-contract-api');

class DocumentContract extends Contract {

  async RegisterDocumentVersion(ctx, versionId, payloadJSON) {
    const exists = await ctx.stub.getState(versionId);
    if (exists && exists.length) throw new Error(`version ${versionId} already registered`);
    const p = JSON.parse(payloadJSON);
    const rec = {
      docType: 'DocumentVersion',
      versionId, docId: p.docId, caseId: p.caseId, versionNo: p.versionNo,
      sha256: p.sha256, classification: p.classification, storageRef: p.storageRef,
      actor: p.actor,
      actorOrg: ctx.clientIdentity.getMSPID(),          // trusted: set from the cert, not the caller
      status: 'ACTIVE',
      ts: ctx.stub.getTxTimestamp().seconds.low,        // deterministic — NOT Date.now()
    };
    await ctx.stub.putState(versionId, Buffer.from(JSON.stringify(rec)));
    ctx.stub.setEvent('DocumentRegistered', Buffer.from(JSON.stringify({ versionId, sha256: p.sha256 })));
    return JSON.stringify(rec);
  }

  async RecordCustodyEvent(ctx, versionId, eventJSON) {
    const raw = await ctx.stub.getState(versionId);
    if (!raw || !raw.length) throw new Error(`version ${versionId} not found`);
    const rec = JSON.parse(raw.toString());
    const e = JSON.parse(eventJSON);
    if (e.action === 'SEALED')      rec.status = 'SEALED';
    if (e.action === 'LEGAL_HOLD')  rec.status = 'LEGAL_HOLD';
    rec.lastAction = e.action; rec.lastActor = e.actor;
    rec.ts = ctx.stub.getTxTimestamp().seconds.low;
    await ctx.stub.putState(versionId, Buffer.from(JSON.stringify(rec)));
    ctx.stub.setEvent('CustodyEventRecorded', Buffer.from(JSON.stringify({ versionId, action: e.action })));
    return JSON.stringify(rec);
  }

  // Read-only (evaluate)
  async VerifyHash(ctx, versionId, sha256) {
    const raw = await ctx.stub.getState(versionId);
    if (!raw || !raw.length) return JSON.stringify({ match: false, record: null });
    const rec = JSON.parse(raw.toString());
    return JSON.stringify({ match: rec.sha256 === sha256, record: rec });
  }

  async GetVersion(ctx, versionId) {
    const raw = await ctx.stub.getState(versionId);
    return raw && raw.length ? raw.toString() : null;
  }

  // The chain-of-custody, for free
  async GetDocumentHistory(ctx, versionId) {
    const it = await ctx.stub.getHistoryForKey(versionId);
    const out = [];
    for (let res = await it.next(); !res.done; res = await it.next()) {
      const m = res.value;
      out.push({
        txId: m.txId,
        timestamp: m.timestamp.seconds.low,
        isDelete: m.isDelete,
        value: m.value && m.value.length ? JSON.parse(m.value.toString()) : null,
      });
    }
    await it.close();
    return JSON.stringify(out);
  }
}
module.exports.contracts = [DocumentContract];
```

**`getHistoryForKey` is the superpower:** the ledger *is* your tamper-proof chain-of-custody report.

**Determinism rules (non-negotiable — chaincode runs on every peer and results must match):**
- ❌ No `Date.now()`, `Math.random()`, timers, or network/HTTP calls.
- ✅ Use `ctx.stub.getTxTimestamp()` for time; derive keys deterministically.
- ✅ Trust `ctx.clientIdentity.getMSPID()` for the submitting org — don't accept it from the payload.

---

## 9. Chaincode lifecycle (deploy/upgrade)

Fabric 2.x uses a multi-step lifecycle: **package → install (each peer) → approve (each org) → commit**.
It's fiddly — **script it from day one** (a `Makefile` or shell script you re-run constantly).

For the sample network the helper does it all:
```bash
cd ~/fabric/fabric-samples/test-network
./network.sh deployCC -ccn document -ccp /path/to/chaincode -ccl javascript -c legal-channel \
  -ccep "OR('PoliceMSP.member')"      # default endorsement policy
```
Manual test with the peer CLI (after setting the org env vars the sample provides):
```bash
peer chaincode invoke -C legal-channel -n document \
  -c '{"function":"RegisterDocumentVersion","Args":["ver-123","{\"docId\":\"d1\",\"caseId\":\"c1\",\"versionNo\":1,\"sha256\":\"abc...\",\"classification\":\"CONFIDENTIAL\",\"storageRef\":\"obj/xyz\",\"actor\":\"SI-Rao\"}"]}' \
  --peerAddresses ... --tlsRootCertFiles ...

peer chaincode query -C legal-channel -n document \
  -c '{"function":"VerifyHash","Args":["ver-123","abc..."]}'
```
Every code change to chaincode → bump the sequence and re-run approve/commit. Automate it.

---

## 10. Identity model

Keep **two layers** separate — this trips people up:

- **Fabric identity (X.509 from Fabric CA):** proves *which org/gateway submitted* a transaction.
  **MVP recommendation: one enrolled gateway identity per org**, held by that org's Express backend.
  The human actor's badge/id + role travel as transaction *arguments*. Far simpler than enrolling
  every officer.
- **App-level PKI digital signature (the statement's "Digital Signatures"):** proves *who authored/
  approved* a document, non-repudiably. The signer's cert signs the document hash; that signature is
  what stands up in court. (This part is shared with the backend/security owner.)

**Later hardening:** issue **per-user Fabric identities** so the submitter's own cert is on-chain.
Start per-org + app-level signatures — you get non-repudiation without enrolling everyone on day one.

Enrollment uses the Fabric CA: register the identity, then enroll to get the cert + private key,
and store the resulting material where the gateway can load it (see §11).

---

## 11. Express ↔ Fabric integration

Use **`@hyperledger/fabric-gateway`** (the modern SDK for Fabric 2.4+/2.5 LTS). This lives inside
your `FabricLedgerService` implementation.

```ts
import { connect, signers } from '@hyperledger/fabric-gateway';
import * as grpc from '@grpc/grpc-js';
// load TLS cert, gateway identity cert + private key from the CA-generated material

const gateway = connect({ client, identity, signer /*, ...*/ });
const contract = gateway.getNetwork('legal-channel').getContract('document');

// WRITE — waits for ordering + commit (~1–2s). Call this from a BullMQ job, never inline in the request.
const bytes = await contract.submitTransaction('RegisterDocumentVersion', versionId, JSON.stringify(payload));

// READ — no ordering, fast.
const res = await contract.evaluateTransaction('VerifyHash', versionId, sha256);
```

### The upload flow (coordinate with the backend team)
```
1. Backend: hash file (SHA-256) → store encrypted blob in MinIO
2. Backend: insert Postgres document_versions row  → ledger_status = PENDING_LEDGER
3. Backend: enqueue BullMQ job "anchorVersion(versionId)"
4. Worker (your code): LedgerService.registerDocumentVersion(...)  → submitTransaction
5. Event listener (your code): on 'DocumentRegistered' commit event → set Postgres
   ledger_status = ANCHORED, store ledger_tx_id
6. UI: shows "verifying on ledger…" then a green "Anchored ✓" badge
```
This async design keeps uploads snappy despite ~1–2s consensus latency.

### The sync worker (CQRS) — your responsibility
```ts
const network = gateway.getNetwork('legal-channel');
const events = await network.getChaincodeEvents('document');
for await (const e of events) {
  // e.eventName: 'DocumentRegistered' | 'CustodyEventRecorded' | ...
  // upsert the Postgres mirror from the committed event (idempotent — you may see replays)
}
```
Make the handler **idempotent** (key on `versionId` + `txId`) and persist a **checkpoint** (last
processed block) so a restart resumes instead of reprocessing from genesis.

---

## 12. Private Data Collections (confidentiality)

Classification / need-to-know maps directly onto Fabric **Private Data Collections (PDCs)**:

- A `SECRET` document's hash + metadata goes into a `police-court` collection — **Forensics peers
  never receive the data**.
- Only a **hash of that private data** is written to the shared channel ledger — so integrity is
  still provable network-wide **without revealing the content**.

This is exactly the "confidential but auditable" property a legal DMS needs, and it's a strong
differentiator. **Treat PDCs as a later phase** — get the basic single-collection flow working first.

---

## 13. Task checklist & phasing

**Phase 1 — Environment & network (Day 1–2)**
- [ ] WSL2 + Docker Desktop + Fabric 2.5 samples installed (§5)
- [ ] `test-network up` with `-ca` runs cleanly; understand `network.sh`
- [ ] Rename mental model: Org1 = Police, Org2 = Court

**Phase 2 — Chaincode (Day 2–4)**
- [ ] Implement `DocumentContract` (§8): Register, RecordCustodyEvent, VerifyHash, GetVersion, GetDocumentHistory
- [ ] Deploy via `deployCC`; invoke/query from the peer CLI
- [ ] Confirm `GetDocumentHistory` returns the full custody chain
- [ ] Ship the `InMemoryLedgerService` stub (§4.3) to the backend team so they're unblocked

**Phase 3 — Express integration (Day 4–7)**
- [ ] Enroll a per-org gateway identity via Fabric CA (§10)
- [ ] Implement `FabricLedgerService` with `fabric-gateway` (§11), same interface as the stub
- [ ] Wire the BullMQ anchor job (submit) + the chaincode-event listener (Postgres sync)
- [ ] Verify the end-to-end upload → PENDING_LEDGER → ANCHORED flow with the backend

**Phase 4 — Hardening (later)**
- [ ] Add Forensics org; strict endorsement policy for sealing (`AND(Police,Court)`)
- [ ] Private Data Collections for SECRET/CONFIDENTIAL
- [ ] Per-user Fabric identities

---

## 15. Pitfalls & honest time budget

- **Develop inside WSL2, keep files off `/mnt/c`.** The #1 source of "works-but-slow / permission" pain.
- **MSP / cert / connection wrangling is the biggest time sink** — budget ~a full day to get identities enrolling and the gateway connecting. It's plumbing, not logic; don't be discouraged.
- **Chaincode lifecycle is fiddly** — script package/install/approve/commit immediately; you'll run it dozens of times.
- **Chaincode must be deterministic** — the most common bug is `Date.now()`/random/HTTP inside chaincode. Use `getTxTimestamp()`.
- **Consensus latency (~1–2s)** — never call `submitTransaction` inline in an HTTP request; always via the BullMQ worker.
- **Fabric is RAM/Docker heavy** — if teammates' laptops struggle, run the network on one shared dev box and point everyone's gateway at it.
- **Don't over-model on-chain** — hashes + lifecycle events only. Every field you add on-chain is a field you can never erase.
- **Event listener must checkpoint** — otherwise a restart reprocesses the whole chain.

---

## 16. Glossary

- **MSP (Membership Service Provider):** an org's identity authority — maps X.509 certs to an org (e.g. `PoliceMSP`).
- **Peer:** a node that holds the ledger, runs chaincode, and endorses transactions.
- **Orderer / ordering service:** sequences transactions into blocks (Raft consensus). Doesn't run chaincode.
- **Channel:** a private "sub-ledger" shared by a set of orgs. We use `legal-channel`.
- **Chaincode (CC):** the smart contract — our `DocumentContract`.
- **World state:** the current key→value snapshot (LevelDB/CouchDB). `getState/putState` operate here.
- **History:** the full immutable sequence of changes to a key — `getHistoryForKey` (our chain-of-custody).
- **Endorsement policy:** which orgs must sign off on a transaction for it to be valid.
- **Private Data Collection (PDC):** data shared with a subset of orgs; only its hash goes on the shared ledger.
- **Fabric CA:** issues the X.509 identities orgs and gateways use.
- **Gateway (fabric-gateway SDK):** the modern client that submits/evaluates transactions from Express.
- **submit vs evaluate:** submit = write (goes through ordering/consensus); evaluate = read (fast, local).

---

## 17. References

- Fabric docs (use the **2.5 LTS** version selector): https://hyperledger-fabric.readthedocs.io
- Key concepts: https://hyperledger-fabric.readthedocs.io/en/release-2.5/key_concepts.html
- fabric-samples (test-network): https://github.com/hyperledger/fabric-samples
- Gateway SDK (`@hyperledger/fabric-gateway`): https://hyperledger.github.io/fabric-gateway/
- Chaincode API (`fabric-contract-api`, Node): https://hyperledger.github.io/fabric-chaincode-node/
- Private Data Collections: https://hyperledger-fabric.readthedocs.io/en/release-2.5/private-data/private-data.html
- Chaincode lifecycle: https://hyperledger-fabric.readthedocs.io/en/release-2.5/chaincode_lifecycle.html

---

## 18. Definition of Done

The blockchain layer is "done" for the MVP when:
1. A running Fabric network with **Police + Court** orgs, `legal-channel`, and CAs.
2. `DocumentContract` deployed, with Register / CustodyEvent / VerifyHash / GetVersion / GetDocumentHistory working.
3. `FabricLedgerService` implements the §4 interface and passes the same tests as the in-memory stub.
4. Upload → **PENDING_LEDGER → ANCHORED** works end-to-end, driven by the BullMQ job + event listener.
5. The **live tamper-detection demo** (§14) works: verify passes when intact, fails when the blob is altered, and `GetDocumentHistory` renders a chain-of-custody.

---

*Handoff document — Blockchain/Integrity layer. Questions on the boundary? The `LedgerService`
interface in §4 is the contract; align on that first.*
