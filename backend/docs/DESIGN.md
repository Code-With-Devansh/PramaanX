# Secure Legal & Investigation Document Management System (DMS)
### Design & Architecture Document

> A secure, centralized, blockchain-anchored platform for law enforcement agencies, courts,
> legal departments, and investigative organizations to store, manage, retrieve, and share
> sensitive legal and investigation documents — while preserving legal validity and
> evidentiary integrity.

---

## Table of Contents

1. [Overview & Problem Statement](#1-overview--problem-statement)
2. [Key Decisions (Summary)](#2-key-decisions-summary)
3. [Integrity & Tamper-Proofing (Hyperledger Fabric)](#3-integrity--tamper-proofing-hyperledger-fabric)
4. [System Architecture](#4-system-architecture)
5. [Tech Stack](#5-tech-stack)
6. [Access Control (RBAC + ABAC)](#6-access-control-rbac--abac)
7. [Governance & Admin Model](#7-governance--admin-model)
8. [Authentication, Sessions & MFA](#8-authentication-sessions--mfa)
9. [Security Layers (Defense in Depth)](#9-security-layers-defense-in-depth)
10. [Data Model](#10-data-model)
11. [AI / Intelligent Features](#11-ai--intelligent-features)
12. [Frontend Design](#12-frontend-design)
13. [API Contract](#13-api-contract)
14. [Build Roadmap & Team Split](#14-build-roadmap--team-split)
15. [Demo Moments](#15-demo-moments)
16. [Glossary](#16-glossary)
17. [App Name Suggestions](#17-app-name-suggestions)
18. [Next Steps](#18-next-steps)

---

## 1. Overview & Problem Statement

### Background
Law enforcement agencies, courts, legal departments, and investigative organizations handle
vast amounts of sensitive documents throughout a case lifecycle:

- FIRs and police reports
- Investigation records
- Witness statements
- Charge sheets
- Court filings
- Evidence records
- Forensic reports
- Legal notices and judgments

Many organizations still rely on paper-based systems or fragmented digital storage, leading to:

- Difficulty locating documents quickly
- Unauthorized access to confidential information
- Document tampering risks
- Lack of version control
- Inefficient inter-department collaboration
- Delays in legal/investigative processes
- Poor auditability and compliance tracking

### Objective
Develop a **Secure Digital Document Management System (DMS)** that lets these organizations
securely store, organize, manage, retrieve, and share sensitive documents. The system must:

- Digitize and centralize document storage
- Ensure secure access and confidentiality
- Prevent unauthorized modifications
- Maintain a complete audit trail of document activities
- Enable efficient document search and retrieval
- Support collaboration among authorized stakeholders
- Ensure compliance with legal and regulatory requirements

> **Note on scope:** The original problem statement's final line ("monitor and manage police
> assets throughout their lifecycle") contradicts the rest of the statement and appears to be a
> template copy-paste error. **Confirmed scope: Document Management System**, not asset tracking.

---

## 2. Key Decisions (Summary)

| Decision | Choice | Rationale |
|---|---|---|
| **Scope** | Document Management System | Matches background + all 7 objectives |
| **Context** | Hackathon prototype → near-production grade | Team project with time to invest |
| **Frontend** | React + Vite + TypeScript | Fast, huge ecosystem, type-safe |
| **Backend** | Express + TypeScript | Chosen stack; layered architecture |
| **Database** | PostgreSQL | Metadata, audit chain, full-text + vector search |
| **Integrity layer** | **Hyperledger Fabric** (permissioned blockchain) | Strongest multi-agency, evidentiary story |
| **Document storage** | Encrypted object storage (MinIO/S3) | Never blob documents into Postgres |
| **Access control** | RBAC + ABAC + case-level ACLs | Role baseline + need-to-know + clearance |
| **Auth** | Hybrid: in-memory access token + revocable refresh (httpOnly cookie) | CSRF-safe + instant revocation |
| **MFA** | Mandatory (TOTP baseline, FIDO2 for privileged) | Non-negotiable for sensitive data |
| **Registration** | Closed / provisioned only — **no public sign-up** | Law-enforcement requirement |

---

## 3. Integrity & Tamper-Proofing (Hyperledger Fabric)

### Design principle
The goal is not "use blockchain" — it is: *no one can alter a document or its history without
detection, and every action is provably attributable.* Achieved via three primitives plus a
permissioned ledger:

| Primitive | Provides | Maps to |
|---|---|---|
| **SHA-256 hash** of every document version | Content tamper detection | "Prevent unauthorized modifications" |
| **Digital signatures (PKI)** on versions & approvals | Non-repudiation (provably who did what) | Digital signatures, legal validity |
| **Append-only, hash-linked audit log** (each row stores prev row's hash) | History tamper detection | "Complete audit trail" |
| **Hyperledger Fabric ledger** | Multi-org tamper-proof source of truth | Blockchain integrity |

### Chosen platform: Hyperledger Fabric
A true enterprise **permissioned** blockchain where separate organizations (Police, Court,
Forensics) run peer nodes. Strongest conceptual fit for multi-agency law enforcement:
- Each agency is its own **Org** with its own Membership Service Provider (MSP) and CA.
- **Endorsement policies** require multi-org approval for sensitive actions (e.g., sealing needs
  Police AND Court).
- **Private Data Collections** control which orgs can even see certain data.
- TLS + mTLS between peers/orderers by default.

### What goes where (critical rule)
- **On-chain:** document version **hashes**, **Merkle roots**, custody/lifecycle events
  (created, signed, transferred, sealed) — plus who and when.
- **Off-chain:** the documents themselves (encrypted object storage) and all queryable metadata
  (PostgreSQL — a fast mirror/index of on-chain truth).
- **NEVER on-chain:** documents, personal data, or anything covered by "right to erasure"
  (cost, privacy, and legal reasons all forbid it).

Postgres becomes the fast index; the ledger is the immutable source of truth for integrity and
custody — each reinforces the other.

### Optional complementary layers
- **TSA (RFC 3161 Timestamping Authority):** an independent, neutral proof that a hash existed
  at a specific time. Fabric already provides tamper-proof timestamps, so a TSA is optional icing —
  a proof even a skeptic who distrusts all agencies would accept.
- **Merkle root anchoring:** batch a day's hashes into one Merkle root; Fabric already uses
  Merkle-tree hashing natively.

---

## 4. System Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    React SPA (Vite + TS)                    │
│  role-aware UI · document viewer · search · audit/verify    │
└───────────────────────────┬───────────────────────────────┘
                            │ HTTPS (in-memory access token + refresh cookie, MFA)
┌───────────────────────────▼───────────────────────────────┐
│                 Express API (TypeScript)                    │
│   controllers → services → repositories                     │
│   authZ (RBAC+ABAC PDP) · validation (Zod) · OpenAPI        │
└───┬──────────┬───────────┬──────────────┬──────────────────┘
    │          │           │              │
┌───▼────┐ ┌───▼──────┐ ┌──▼───────┐ ┌────▼───────────────┐
│Postgres│ │ Object   │ │  Redis   │ │  Worker pool        │
│metadata│ │ storage  │ │ + BullMQ │ │  OCR · virus scan   │
│ audit  │ │(MinIO/S3 │ │  queue   │ │  hashing · NER      │
│pgvector│ │ encrypted│ │ +sessions│ │  ledger · notify    │
└────────┘ └──────────┘ └──────────┘ └────────┬───────────┘
                                               │
                                   ┌───────────▼──────────┐
                                   │  Hyperledger Fabric   │
                                   │  (hashes + custody)   │
                                   └───────────────────────┘
```

**Key rule:** documents live in encrypted object storage (MinIO in dev, S3/gov-cloud in prod);
PostgreSQL holds only metadata, hashes, and the audit chain.

---

## 5. Tech Stack

### Frontend
- **React + Vite + TypeScript**
- **React Router** with route guards (protected routes check role/permission)
- **TanStack Query (React Query)** — server-state caching, background refetch, loading/error states
- **Zustand or Context** — minimal client state (auth/current-user, theme). *Not Redux* (see §12)
- **React Hook Form + Zod** — forms; reuse backend Zod schemas
- **shadcn/ui (Radix + Tailwind)** or **MUI** — component kit; **TanStack Table** for data grids
- **react-pdf / PDF.js** — document viewing

### Backend
- **Express + TypeScript**, layered (controllers → services → repositories)
- **Zod** validation; auto-generated **OpenAPI/Swagger** docs
- **Prisma or Drizzle** ORM
- **Argon2** password hashing; **TOTP MFA**; optionally front with **Keycloak** for SSO/RBAC

### Storage & infra
- **MinIO** (S3-compatible) with **envelope encryption** (per-document data key wrapped by KMS master key)
- **Postgres full-text (tsvector)** → **pgvector** for semantic search (→ Meilisearch/OpenSearch if needed)
- **Redis + BullMQ** — async jobs (OCR, virus scan via **ClamAV**, hashing, thumbnails, ledger, notifications) + session/refresh store
- **Docker Compose** (one-command dev), TLS, rate limiting, CI/CD

---

## 6. Access Control (RBAC + ABAC)

Access = the intersection of role permission, case assignment, clearance, and jurisdiction.

```
allow = role permission          ← RBAC (what can this TYPE of user do?)
      ∩ assigned to the case      ┐
      ∩ clearance ≥ classification │ ← ABAC (can THIS user touch THIS doc right now?)
      ∩ same jurisdiction         ┘
```

### RBAC — Role-Based Access Control
Permissions attached to roles; users get roles. Coarse-grained baseline job function.
- **Roles:** Investigating Officer, Supervisor, Public Prosecutor, Judge/Court Clerk,
  Forensic Analyst, Records Admin, Security Admin, Org Admin, System Admin, **Auditor** (read-only, sees all).

### ABAC — Attribute-Based Access Control
Access decided by attributes of user (jurisdiction, clearance, cases assigned), document
(classification, owning dept), and context (time/IP). Fine-grained, dynamic, enforces need-to-know.

### Clearance vs Classification
Two sides of the same ladder: `PUBLIC → RESTRICTED → CONFIDENTIAL → SECRET`
- **Classification** = how sensitive the **document** is.
- **Clearance** = how sensitive a document the **user** is trusted to access.
- **Rule:** a user can open a document only if **clearance ≥ classification** — AND the other
  need-to-know checks (case assignment, jurisdiction) also pass.

**Example:** Officer Rao (Investigating Officer role, CONFIDENTIAL clearance) can open case
#FIR-102's CONFIDENTIAL chargesheet only because he's assigned to it, cleared to that level, and
in-jurisdiction. Remove any one attribute → denied, even though his role is unchanged. A SECRET
forensic report is blocked for him regardless of assignment.

### Special states
- **Sealed** documents, **legal hold** (blocks deletion), **redacted disclosure copies** for
  sharing outside the need-to-know circle.

---

## 7. Governance & Admin Model

**Core principle: there is deliberately NO single all-powerful admin.** A god-admin who can read
everything, grant themselves access, and edit logs is an insider-threat disaster and destroys
evidentiary integrity. Control is split by **separation of duties, least privilege, and full
accountability** — everyone, including admins, is audited.

### Scoped admin roles
| Admin role | Controls | Cannot |
|---|---|---|
| **System / IT Admin** | Servers, deployments, backups, uptime | Read case documents or grant self case access |
| **Org Admin** (per agency) | Own agency's users & Fabric identities | Manage another agency's users / ledger rules alone |
| **Security / Access Admin** | Roles & ABAC policies (the rules) | Assign self to cases or read content |
| **Records Admin / Registrar** | Retention, classification defaults, disposition | Override classification / delete under legal hold |
| **Case Supervisor / IO** | Access to their own case (within clearance limits) | Touch cases they aren't assigned to |
| **Auditor** | Read-only view of ALL activity logs | Change anything or read document content |

### What controls what
| Mechanism | Governs |
|---|---|
| Authentication + MFA | Are you who you claim? |
| RBAC | Baseline permissions for your role |
| ABAC | Case assignment, clearance ≥ classification, jurisdiction |
| **Policy Decision Point (PDP)** | Evaluates every request → allow/deny (central service in Express) |
| Fabric endorsement policies | Which cross-agency actions need whose approval |
| Fabric MSP + CA (per org) | Who is a valid member of each agency |
| Private Data Collections | Which agencies can see certain data |
| Immutable audit log / ledger | Records every grant, revoke, view, edit — incl. admin actions |

### Chain of authority
- No one can grant themselves more than their role allows (PDP checks the grantor's authority).
- **Case-level access** granted by the case's supervisor, bounded by grantee clearance + jurisdiction.
- **Role/policy changes** via Security Admin; sensitive changes require **dual control** (two-person approval).
- **Network-level rules** (add an org, change endorsement policy) require **multi-org consensus** in Fabric.
- Every grant/revoke is itself logged immutably.

### Non-negotiable guardrails
1. Admins are audited too.
2. IT power ≠ data access (whoever runs servers cannot read confidential content).
3. Dual control for seal / delete / policy change / clearance escalation.
4. Federated control — no single party controls the system.

---

## 8. Authentication, Sessions & MFA

### Stateful vs stateless → Hybrid
Pure stateless JWT is **rejected**: you cannot revoke a token before expiry, which is
unacceptable when an officer is suspended, a device is lost, or a role/clearance changes and
access must be cut **now**.

**Chosen: hybrid**
- **Short-lived stateless access token (5–15 min)** — sent as `Authorization: Bearer …`
- **Stateful, revocable refresh token** stored server-side in **Redis** (instant kill-switch)
- Revoking the refresh token ends the session within minutes.
- Wire revocation to permission/clearance changes so access re-evaluates immediately.

### Token storage (frontend)
- **Access token → in-memory** (React state/closure). CSRF-safe (header-based); no persistent copy.
- **Refresh token → httpOnly + Secure + SameSite=Strict cookie**, scoped to `/auth/refresh`,
  stored server-side (revocable).
- **On app load/reload →** call `/auth/refresh` once to restore the access token (brief loading state).
- **Rotate refresh token on every use**; detect reuse → revoke the whole token family.
- **Never use localStorage/sessionStorage** for either token (trivially stealable via XSS).

> **Myth to kill:** in-memory storage does NOT protect against XSS — it protects against CSRF and
> persistent theft. The real XSS defense is a strong **Content-Security-Policy** + sanitizing
> anything user-supplied you render (comments, OCR text, document previews). If XSS is possible,
> the attacker wins regardless of where the token lives.

### Registration — closed / provisioned only
**No public sign-up exists.** Accounts are created by an authority:
1. **Identity proofing** against agency records (badge/employee ID, Bar Council ID, court credentials).
2. **Org Admin provisions** the account with role + clearance + jurisdiction; Fabric CA enrolls the identity.
3. **First login** — set strong password + **enroll MFA** before any access.
4. **Deprovisioning** — disable account, revoke Fabric cert (CRL), kill active sessions.
- **External stakeholders** (e.g., defense lawyer): sponsored, scoped, time-limited guest accounts —
  never self-registration, never broad access.

### MFA — mandatory for everyone
- **Baseline:** TOTP (authenticator app), enforced on first login.
- **Privileged roles (admins, judges, prosecutors):** FIDO2 / WebAuthn hardware keys (phishing-resistant).
- **Avoid SMS OTP** as primary (SIM-swap risk).
- **Step-up authentication** — re-prompt on highest-stakes actions (seal, export evidence bundle,
  change permissions, escalate clearance) even mid-session.
- **Recovery is admin-assisted** — backup codes at enrollment; no self-service email reset.

---

## 9. Security Layers (Defense in Depth)

HTTPS/TLS is the mandatory floor, not the whole building. "More secure" = layers around it.

| Layer | What it adds |
|---|---|
| **1. VPN / Zero-Trust (ZTNA)** | Don't expose to the public internet; only authenticated agency devices reach the system. Biggest real gain. |
| **2. mTLS (mutual TLS)** | Both client and server present certs (service-to-service; ideally agency clients). Fabric already does mTLS between peers. |
| **3. Hardened TLS** | TLS 1.3 only, disable weak ciphers, HSTS, HTTP→HTTPS redirect, optional cert pinning in a dedicated client. |
| **4. End-to-end / client-side encryption** | Server stores only ciphertext. Strongest, but breaks server-side OCR/search/AI. Use only for highest classifications (e.g., SECRET). |
| **5. Key protection (KMS/HSM)** | Keys managed in a KMS; HSM for highest assurance (keys never leave hardware). Protects data at rest. |

**Also required (HTTPS only covers transit):**
- **Encryption at rest** — envelope-encrypted blobs in MinIO.
- **AuthZ** — RBAC/ABAC.
- **Ledger integrity** — Fabric + hash-chain + signatures.

**Priority for this project:** VPN/ZTNA + mTLS give the largest security jump with least
disruption. In dev, use **mkcert** for trusted localhost HTTPS; in prod, Let's Encrypt or gov CA,
terminating TLS at a reverse proxy (Caddy/Nginx) or load balancer.

---

## 10. Data Model

Documents live in encrypted object storage; Postgres holds metadata, hashes, and the audit chain.

```
users, roles, permissions, user_roles
cases            (case_number, type, status, jurisdiction, ...)
case_assignments (case_id, user_id, role_on_case)
documents        (id, case_id, doc_type[FIR|statement|chargesheet|forensic|judgment|...],
                  classification, current_version_id)
document_versions(id, document_id, version_no, storage_key, sha256_hash, size, mime,
                  created_by, created_at)                            ← immutable
signatures       (version_id, signer_id, algo, signature, cert, ts)
acls             (subject[user|role], case_id/doc_id, permission)
audit_log        (id, prev_hash, entry_hash, actor_id, action, target_type, target_id,
                  ip, ts, payload)                                   ← hash-chained
anchors          (merkle_root, external_ref, from_id, to_id, ts)
entities         (version_id, type[person|section|vehicle|date], value)  ← from NER
tags, comments, tasks, legal_holds, retention_policies, notifications
```

**Versioning rule:** edits never overwrite — each change creates a new immutable
`document_version`. "Restore" creates a new version pointing back. Gives version control *and*
evidentiary integrity for free.

---

## 11. AI / Intelligent Features

Ranked by value-per-effort:

1. **OCR** (Tesseract/PaddleOCR) — turn scanned FIRs into searchable text. Highest impact.
2. **Auto-classification & tagging** — detect document type on upload.
3. **NER / entity extraction** — persons, IPC/BNS sections, dates, vehicle numbers, locations →
   auto-link related cases. Populates the `entities` table.
4. **Semantic search + case Q&A (RAG)** — pgvector + LLM to "ask questions about this case file."
   Best demo moment.
5. **Auto-redaction of PII** for disclosure copies.
6. **Near-duplicate detection** and **long-file summarization.**

### NER details
Named Entity Recognition finds and labels key entities in text. Example:
> "On **12/03/2026**, **SI Rao** arrested **Amit Kumar** near **MG Road, Pune** in connection with
> **FIR-102**, vehicle **MH-12-AB-1234**, under **IPC §420**."

Extracts → Person (SI Rao, Amit Kumar), Date, Location, Case ref, Vehicle, Legal section.

**Value:** auto-linking cases across documents, entity-based search, auto-tagging, and locating
PII for redaction. **For the stack:** generic entities via spaCy/cloud NLP; domain-specific
(IPC/BNS sections, FIR numbers, plates) via regex + fine-tuned model or an **LLM returning
structured JSON** (fastest route to good results). Runs in the async pipeline:
upload → OCR → NER → entities saved → available for search and cross-case linking.

---

## 12. Frontend Design

### App shell
Top bar (global search + notifications + user/role), role-aware left nav (admin items only for
admins), main content, and a right context panel for metadata/activity on detail views. A
clearance badge is always visible.

### Screens (grouped & prioritized)
- **Auth & onboarding:** Login → MFA step → dashboard; first-login (set password + enroll MFA with
  QR + backup codes); step-up MFA modal; **no public registration** — Admin → Create user instead.
- **Core loop (build first):** Dashboard (role-aware), Cases list, **Case detail (the hub)**,
  Document viewer (PDF/image + metadata + version history + **integrity badge** + signatures +
  watermarked download), Upload flow (drag-drop, classification + doc type + case, live status),
  Version history (compare/restore), Search (global + advanced/faceted).
- **Security/integrity (differentiators):** Integrity verification panel, chain-of-custody /
  evidence bundle export.
- **Collaboration:** Sharing/permissions dialog, comments/annotations, tasks, notifications center.
- **Admin & oversight (role-gated):** User management, role & policy management, audit log viewer,
  retention/legal-hold, active sessions.

### Case detail wireframe (most important screen)
```
┌ Case #FIR-102  [CONFIDENTIAL] ────────────────  [Share] [Export] ┐
│ Status: Under Investigation · Jurisdiction: Pune · IO: SI Rao    │
├───────────────┬──────────────────────────────────┬──────────────┤
│ DOCUMENTS     │  (selected doc preview / list)    │ ACTIVITY     │
│ ▸ FIR         │                                   │ • Rao viewed │
│ ▸ Statements  │   📄 chargesheet_v3.pdf           │ • Signed by… │
│ ▸ Chargesheet │   ✅ Verified · v3 · signed       │ • Uploaded…  │
│ ▸ Forensics   │   [View] [History] [Verify]       │ (audit feed) │
│ [+ Upload]    │                                   │              │
└───────────────┴──────────────────────────────────┴──────────────┘
```

### Reusable components
Classification badge · integrity/status badge · document card & table row · file uploader with
status · `<Can>` permission wrapper · confirm-with-step-up modal · audit/activity timeline ·
user/role picker · empty/loading/skeleton states.

### Domain-specific patterns (what makes it legal-grade)
- **Classification badges everywhere** — color-coded, plus a banner on the viewer.
- **Integrity status front-and-center** — ✅ Verified / ⚠️ Tampered / ⏳ Pending (the demo money-shot).
- **Watermark on view/download** — viewer's name + timestamp to deter leaks.
- **Redaction view** — lower-clearance users see the redacted copy.
- **`<Can permission="...">` gating** — hide/disable actions the user can't perform.
  **UX only — the backend must still enforce it. Never trust the frontend for security.**
- **Careful access-denied UX** — don't reveal the existence of documents a user isn't cleared to see.
- **Step-up + confirm** on seal / export / delete / permission-change.
- **Search-first everything** — "can't find documents" is the #1 pain in the problem statement.

### Design direction
Trustworthy, calm, institutional-but-modern. Neutral palette + one accent; reserve color for
meaning (classification/status). Dense but legible typography, strong hierarchy, solid
accessibility (WCAG — often a gov requirement). Wireframe in Figma before coding.

### Why NOT Redux
Most "state" in this app is **server state** (cases, documents, users, audit logs, search results)
— that's TanStack Query's job (fetching, caching, invalidation, loading/error). Putting it in
Redux means hand-writing all of that as boilerplate; Redux doesn't solve the hard part (server
sync). The genuine **client** global state is tiny (current user, theme, a few UI toggles) —
Context/Zustand handles it in a few lines.

- **Server data → React Query** (~90%)
- **Small client state → Zustand/Context** (~10%)

Reach for Redux only with complex interdependent client-side state (collaborative editor,
drag-drop canvas, heavy undo/redo) — none of which this CRUD-over-server-data app has. (Redux
Toolkit + RTK Query is the modern, lighter Redux, but vs React Query it's a lateral move — not
worth adopting if you're not already invested.)

### Build approach
1. **Shell first** — layout, routing, auth guard, design system, `useAuth`.
2. **Core loop** — case detail → viewer → upload → search (demoable on its own).
3. **Then** admin, collaboration, integrity/verify polish.
4. **Work against the OpenAPI spec** with mocked responses (MSW/json-server) so FE isn't blocked.

---

## 13. API Contract

### Conventions
- **Base path:** `/api/v1`
- **Auth:** in-memory access token as `Authorization: Bearer …`; refresh via httpOnly cookie.
  `401` = not logged in, `403` = logged in but not allowed.
- **Content-Type:** `application/json`, except uploads (`multipart/form-data`).
- **Sensitive actions** (seal, delete, export, sign, permission change) require
  `X-Step-Up-Token: <token>` — else `403 { code: "STEP_UP_REQUIRED" }`.
- **Errors:** `{ error: { code, message, details? } }`. Codes: `UNAUTHENTICATED`, `FORBIDDEN`,
  `STEP_UP_REQUIRED`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `LEGAL_HOLD`, `INTEGRITY_FAILED`.
- **Lists:** `?page=1&pageSize=20&sort=-updatedAt` → `Paginated<T>`.

```ts
type ID = string;         // UUID
type ISODate = string;    // "2026-08-24T14:03:00Z"
interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number; }
interface ApiError { error: { code: string; message: string; details?: unknown; } }
```

### Shared enums & entities
```ts
type Classification   = "PUBLIC" | "RESTRICTED" | "CONFIDENTIAL" | "SECRET";
type CaseStatus       = "OPEN" | "UNDER_INVESTIGATION" | "CHARGESHEETED" | "IN_TRIAL" | "CLOSED" | "ARCHIVED";
type DocType          = "FIR" | "POLICE_REPORT" | "INVESTIGATION_RECORD" | "WITNESS_STATEMENT"
                      | "CHARGE_SHEET" | "COURT_FILING" | "EVIDENCE_RECORD" | "FORENSIC_REPORT"
                      | "LEGAL_NOTICE" | "JUDGMENT" | "OTHER";
type Role             = "INVESTIGATING_OFFICER" | "SUPERVISOR" | "PROSECUTOR" | "JUDGE" | "COURT_CLERK"
                      | "FORENSIC_ANALYST" | "RECORDS_ADMIN" | "SECURITY_ADMIN" | "ORG_ADMIN"
                      | "SYSTEM_ADMIN" | "AUDITOR";
type IntegrityStatus  = "VERIFIED" | "TAMPERED" | "PENDING";
type ProcessingStatus = "SCANNING" | "OCR" | "INDEXING" | "READY" | "FAILED";

interface UserSummary { id: ID; fullName: string; role: Role; org: string; badgeId?: string; }
interface User extends UserSummary {
  email: string; clearance: Classification; jurisdiction: string;
  status: "ACTIVE" | "DISABLED"; mfaEnrolled: boolean;
  createdAt: ISODate; lastLoginAt?: ISODate;
}
interface Me extends User { permissions: string[]; }   // drives the <Can> component

interface CaseSummary {
  id: ID; caseNumber: string; title: string; type: string; status: CaseStatus;
  classification: Classification; jurisdiction: string; documentCount: number; updatedAt: ISODate;
}
interface Case extends CaseSummary {
  description?: string; createdBy: UserSummary; assignedOfficers: (UserSummary & { roleOnCase: string })[];
  legalHold: boolean; createdAt: ISODate;
}

interface DocumentSummary {
  id: ID; caseId: ID; title: string; docType: DocType; classification: Classification;
  currentVersionNo: number; integrityStatus: IntegrityStatus; processingStatus: ProcessingStatus; updatedAt: ISODate;
}
interface Document extends DocumentSummary {
  description?: string; createdBy: UserSummary; currentVersionId: ID;
  versionsCount: number; tags: string[]; sealed: boolean; createdAt: ISODate;
}

interface DocumentVersion {
  id: ID; documentId: ID; versionNo: number; fileName: string; mimeType: string; sizeBytes: number;
  sha256: string; ledgerTxId?: string; signatureCount: number; uploadedBy: UserSummary; note?: string; createdAt: ISODate;
}
interface Signature { id: ID; versionId: ID; signer: UserSummary; algorithm: string; signedAt: ISODate; valid: boolean; }
interface AuditEntry {
  id: ID; actor: UserSummary; action: string; targetType: string; targetId: ID;
  ip: string; timestamp: ISODate; entryHash: string; prevHash: string; details?: Record<string, unknown>;
}
interface AccessGrant {
  id: ID; subjectType: "USER" | "ROLE"; subjectId: ID; resourceType: "CASE" | "DOCUMENT"; resourceId: ID;
  permission: "READ" | "WRITE" | "MANAGE"; grantedBy: UserSummary; grantedAt: ISODate; expiresAt?: ISODate;
}
interface Entity { type: "PERSON" | "LOCATION" | "DATE" | "LEGAL_SECTION" | "VEHICLE" | "ORG"; value: string; documentId: ID; }
interface Notification { id: ID; type: string; message: string; link?: string; read: boolean; createdAt: ISODate; }
```

### 1. Auth & session
```ts
POST /auth/login
  Req: { username: string; password: string }
  Res 200: { mfaRequired: boolean; user?: Me }
POST /auth/mfa/verify        Req: { code: string }                Res 200: { accessToken: string; user: Me }  // sets refresh cookie
POST /auth/refresh           Res 200: { accessToken: string }     // uses refresh cookie; rotates it
POST /auth/logout            Res 204
GET  /auth/me                Res 200: Me
POST /auth/password          Req: { currentPassword?: string; newPassword: string }   Res 204
POST /auth/mfa/enroll/start  Res 200: { secret: string; otpauthUrl: string; qrDataUrl: string }
POST /auth/mfa/enroll/verify Req: { code: string }               Res 200: { backupCodes: string[] }
POST /auth/step-up           Req: { code: string }               Res 200: { stepUpToken: string; expiresAt: ISODate }
```

### 2. Cases
```ts
GET  /cases?status=&q=&assignedToMe=&page=&pageSize=   Res 200: Paginated<CaseSummary>
POST /cases   Req: { caseNumber; title; type; classification; jurisdiction; description? }   Res 201: Case
GET   /cases/:id                                        Res 200: Case
PATCH /cases/:id   Req: Partial<{ title; status; classification; description }>   Res 200: Case
POST  /cases/:id/officers     Req: { userId: ID; roleOnCase: string }   Res 200: Case
DELETE /cases/:id/officers/:userId                      Res 200: Case
POST  /cases/:id/legal-hold   Req: { reason: string }   Res 200: Case     // step-up
DELETE /cases/:id/legal-hold                            Res 200: Case     // step-up
```

### 3. Documents
```ts
GET /cases/:id/documents?docType=&classification=&page=   Res 200: Paginated<DocumentSummary>
POST /cases/:id/documents   // multipart/form-data: file=<binary>, metadata={title,docType,classification,description?,tags?} (JSON)
  Res 202: Document           // processingStatus = "SCANNING"; poll GET /documents/:id
GET   /documents/:id             Res 200: Document
PATCH /documents/:id  Req: Partial<{ title; classification; description; tags }>   Res 200: Document
POST  /documents/:id/seal        Res 200: Document        // step-up
DELETE /documents/:id            Res 204                  // step-up; 409 LEGAL_HOLD if on hold
GET   /documents/:id/entities    Res 200: { items: Entity[] }
```

### 4. Versions, download, integrity & signatures
```ts
GET  /documents/:id/versions                             Res 200: { items: DocumentVersion[] }
POST /documents/:id/versions   // multipart: file + note?  → new immutable version   Res 202: DocumentVersion
GET  /documents/:id/versions/:vid                        Res 200: DocumentVersion
POST /documents/:id/versions/:vid/restore                Res 200: Document
GET  /documents/:id/versions/:vid/download?watermark=true Res 200: { url: string; expiresAt: ISODate }  // signed URL
GET /documents/:id/integrity
  Res 200: { status: IntegrityStatus; sha256; ledgerTxId; ledgerHash; matches: boolean; signatures: Signature[]; lastCheckedAt: ISODate }
GET /documents/:id/custody
  Res 200: { events: { timestamp; actor: UserSummary; action; versionNo?; ledgerTxId?; hash }[] }
POST /documents/:id/versions/:vid/sign                   Res 201: Signature   // step-up
POST /cases/:id/export   Req: { documentIds?: ID[]; includeCustody: boolean; format: "PDF" | "ZIP" }   Res 202: { jobId: ID }  // step-up
GET /exports/:jobId      Res 200: { status: "PENDING" | "READY" | "FAILED"; downloadUrl?; expiresAt? }
```

### 5. Search
```ts
GET /search?q=&docType=&classification=&caseId=&entity=&dateFrom=&dateTo=&page=&pageSize=
  Res 200: {
    items: (DocumentSummary & { snippet: string; score: number })[];
    facets: { docType: Record<DocType, number>; classification: Record<Classification, number> };
    total; page; pageSize;
  }
```

### 6. Access / sharing
```ts
GET  /documents/:id/access                               Res 200: { items: AccessGrant[] }
POST /documents/:id/access
  Req: { subjectType: "USER" | "ROLE"; subjectId: ID; permission: "READ" | "WRITE" | "MANAGE"; expiresAt? }
  Res 201: AccessGrant                                   // step-up; 403 if grantee clearance < classification
DELETE /access/:grantId                                  Res 204   // step-up
```

### 7. Users & admin
```ts
GET  /users?role=&org=&status=&q=&page=                  Res 200: Paginated<User>
POST /users   // provision — NO public registration
  Req: { fullName; email; role: Role; clearance: Classification; jurisdiction; org; badgeId? }
  Res 201: { user: User; activationToken: string }
GET   /users/:id                                         Res 200: User
PATCH /users/:id   Req: Partial<{ role; clearance; jurisdiction; status }>   Res 200: User   // step-up
POST  /users/:id/deactivate                              Res 200: User       // revokes cert + kills sessions
POST  /users/:id/reset-mfa                               Res 204
GET    /users/:id/sessions   Res 200: { items: { id; ip; device; createdAt; lastSeenAt }[] }
DELETE /sessions/:sessionId  Res 204
```

### 8. Audit
```ts
GET /audit?actorId=&action=&targetType=&targetId=&dateFrom=&dateTo=&page=   Res 200: Paginated<AuditEntry>
POST /audit/export   Req: { filters: {...}; format: "CSV" | "PDF" }   Res 202: { jobId: ID }
```

### 9. Collaboration & notifications
```ts
GET  /documents/:id/comments   Res 200: { items: { id; author: UserSummary; body; createdAt }[] }
POST /documents/:id/comments   Req: { body: string }   Res 201: Comment
GET  /cases/:id/tasks          Res 200: { items: Task[] }
POST /cases/:id/tasks          Req: { title; assigneeId: ID; dueAt? }   Res 201: Task
PATCH /tasks/:id               Req: Partial<{ status; assigneeId; dueAt }>   Res 200: Task
GET  /notifications            Res 200: Paginated<Notification>
POST /notifications/:id/read   Res 204
POST /notifications/read-all   Res 204
```

### 10. Reference (dropdowns)
```ts
GET /reference/enums
  Res 200: { classifications; docTypes; roles; caseStatuses; caseTypes }
```

---

## 14. Build Roadmap & Team Split

| Phase | Deliverable | Why |
|---|---|---|
| **0 — Foundations** | Repo, Docker, CI, auth skeleton, DB schema, RBAC | Unblocks everyone |
| **1 — MVP core** | Encrypted upload+hash, case/doc CRUD, versioning, viewer, full-text search, audit log | Demoable heart |
| **2 — Security** | Hash-chained audit + verify UI, digital signatures, classification/ABAC, MFA, virus scan | Differentiator |
| **3 — Intelligence** | OCR, auto-tagging, NER, semantic search/RAG | Wow factor |
| **4 — Collab & compliance** | Sharing workflows, comments/tasks, legal holds, retention, chain-of-custody report, Fabric integration | "Near-production" credibility |
| **5 — Polish** | Dashboards, notifications, perf, security pass | Judging polish |

### Backend team split (4)
Frontend · Backend/API · Security+integrity+DevOps (incl. Fabric) · AI/search.

### Frontend team split
| Owner | Screens | Endpoints |
|---|---|---|
| **Dev A — Shell + Auth** | Login, MFA, first-login, step-up, app shell, `useAuth`/`<Can>` | `/auth/*`, `/auth/me`, `/reference/enums` |
| **Dev B — Case & Document core** | Cases list, case detail, viewer, upload, versions | `/cases/*`, `/documents/*`, `/documents/:id/versions/*` |
| **Dev C — Integrity + Search + Sharing** | Verify panel, custody, export, search, permissions dialog | `/integrity`, `/custody`, `/export`, `/search`, `/access/*` |
| **Dev D — Admin + Audit + Collab** | User mgmt, sessions, audit viewer, comments/tasks/notifications | `/users/*`, `/sessions/*`, `/audit/*`, `/comments`, `/tasks`, `/notifications` |

**Do now:** (1) shared `types.ts` both FE and BE import (or generate from OpenAPI); (2) mock
endpoints (MSW/json-server) so all devs build in parallel before the real backend lands.

---

## 15. Demo Moments

- **Live tamper detection:** open a document, change one byte in storage, hit "Verify" →
  integrity badge flips red, audit log flags it.
- **Court-ready evidence bundle:** one click exports a case's documents + a chain-of-custody PDF
  with an integrity certificate (hashes, signatures, ledger reference).
- **Ask the case file:** semantic Q&A over a full case.

The three winning differentiators: **verifiable integrity, need-to-know access control, and the
court-ready evidence bundle** — these make it read as a *legal-grade* system, not a file uploader.

---

## 16. Glossary

- **OpenAPI** — a standard YAML/JSON format describing a REST API's endpoints, params, and
  responses. Powers Swagger UI (interactive docs), client/type generation, and acts as the
  FE↔BE contract. (Distinct from "open API" = a publicly available API.)
- **RBAC** — Role-Based Access Control: permissions attached to roles; answers "what can this
  *type* of user do?"
- **ABAC** — Attribute-Based Access Control: access decided by attributes (clearance, jurisdiction,
  case assignment) via rules; answers "can *this* user touch *this* document *right now*?"
- **Clearance** — a security level assigned to a **person** (how sensitive a document they may
  access). Counterpart to a document's **classification**. Rule: clearance ≥ classification.
- **Classification** — the sensitivity level of a **document** (PUBLIC → RESTRICTED → CONFIDENTIAL → SECRET).
- **PDP (Policy Decision Point)** — the central service that evaluates every request against
  RBAC+ABAC and returns allow/deny.
- **NER (Named Entity Recognition)** — NLP technique that finds and labels entities (persons,
  dates, locations, legal sections, vehicle numbers) in text.
- **TSA (Timestamping Authority, RFC 3161)** — trusted third party that cryptographically proves
  a hash existed at a specific time; only the hash is sent, never the document.
- **Merkle root** — a single hash that fingerprints a whole set of items via a Merkle tree.
  Changing any item changes the root. Enables cheap anchoring and per-item proofs of inclusion.
- **mTLS (mutual TLS)** — both client and server present certificates, so each authenticates the other.
- **ZTNA (Zero-Trust Network Access)** — no implicit trust by network location; every access is
  authenticated/authorized, typically keeping the system off the public internet.
- **Envelope encryption** — a per-document data key encrypts the file; a KMS master key encrypts
  the data key.
- **Step-up authentication** — re-prompting for MFA on high-stakes actions even within an active session.
- **Hyperledger Fabric** — a permissioned enterprise blockchain where separate organizations run
  peer nodes; uses MSPs/CAs, endorsement policies, and private data collections.

---

## 17. App Name Suggestions

**Professional & brandable:** LexVault (top pick), CaseChain, Provenance/ProvenChain, Custodia,
AegisDMS, VeriDoc.

**Acronym-style:** SECURE (Secure Evidence & Case Unified Records Environment), SATARK (Secure
Audit-Trail Archival & Records Keeper — *satark* = "vigilant"), PRAHARI (Police Records Archival &
Handling with Audit, Retrieval & Integrity — *prahari* = "sentinel").

**India-context:** Nyaya ("justice"), Suraksha ("protection"), Praman-Kosh ("evidence vault").

**Recommendations:** LexVault or CaseChain (polished); SATARK or PRAHARI (meaningful acronym for
judges); Nyaya (gravitas + local resonance).

> **Cautions:** check for clashes with existing systems (CCTNS, ICJS, eSakshya; *Pramaan* is used
> by a govt service) and do a domain/trademark check. Add a distinct suffix to common security
> words (Aegis, Sentinel, Vault) for searchability.

---

## 18. Next Steps

1. **Pick an app name** and write a one-line tagline for the pitch deck.
2. **Scaffold the repo** — Docker Compose + Express skeleton + schema + auth + React shell.
3. **Create shared `types.ts`** (or OpenAPI spec) and **mock endpoints** so FE/BE build in parallel.
4. **Build order:** shell → core document loop → security/integrity → AI → collaboration → polish.
5. **Stand up a Fabric dev network** early (even a single-org test network) so the integrity layer
   isn't left to the end.

---

*Document generated from design discussion — Secure Legal & Investigation DMS.*
