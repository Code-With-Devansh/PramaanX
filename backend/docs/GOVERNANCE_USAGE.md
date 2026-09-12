# Governance Sudo Actions — Usage Guide

How to operate the DMS admin-hierarchy governance subsystem: bootstrap, the nine
privileged ("sudo") actions, the Tier-3 recovery ceremony, and the ABAC policy
overlay. This is the operator/developer companion to `docs/GOVERNANCE.md` (which
covers the *why* and the trust model). Here we cover the *how* — exact endpoints,
payloads, and step-by-step flows.

> **Base path.** All routes are mounted under `/api/v1`. Examples below show the
> full path. Replace host/port with your deployment.

---

## 1. Core concepts (the 30-second model)

- **Pools.** Authority lives in **admin pools**, not in a user's `role` column.
  Three pool types: the org-less singletons `SYSTEM_ADMIN` and `SECURITY_ADMIN`,
  and one `ORG_ADMIN` pool **per org**. Each pool has a quorum `k` of `m` members
  (`k = floor(m/2)+1` by default, hard floor `k ≥ 2`, `m ≥ 2`).
- **Proposals.** A privileged change is a **proposal** that goes through
  `file → approve → (object) → execute`. Quorum is re-counted from the real
  approval rows at execute time — never a stored "approved" flag.
- **Separation of duties.** A pool can never approve a change to *itself* alone;
  a distinct **cross-tier** pool must co-sign.
- **Step-up MFA per vote.** Each `approve` and `execute` needs a *fresh*
  step-up token. A token's `jti` is consumed once (anti-replay), and one person
  can vote once per proposal.
- **Audit.** Every mutation writes an append-only, hash-chained `audit_log` row
  inside the same transaction.

---

## 2. Authentication headers

| Header | Needed for | Notes |
|---|---|---|
| `Authorization: Bearer <access-token>` | every route except `bootstrap` / `regenesis` | normal login token |
| `x-step-up-token: <step-up-token>` | `approve`, `execute` | a **fresh** step-up token per vote; obtain via the MFA step-up flow |

`bootstrap` and `regenesis` are intentionally **unauthenticated** — they run when
no admin exists (or the whole top tier is locked out). They are gated instead by
the genesis **secret commitment** and are meant to be reachable only over an
admin-only channel (the genesis CLI).

---

## 3. Genesis bootstrap (one-time)

Stands up the first pools + founding members. Precondition: `admin_pools` is
empty (enforced under an advisory lock, so a second call can never succeed).

```bash
curl -sX POST http://localhost:3000/api/v1/governance/bootstrap \
  -H 'content-type: application/json' \
  -d '{
    "secret": "<the-founding-secret>",
    "roster": [
      { "fullName": "Ada Lovelace",  "email": "ada@gov.example",   "role": "SYSTEM_ADMIN",   "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "Grace Hopper",  "email": "grace@gov.example", "role": "SYSTEM_ADMIN",   "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "Radia Perlman", "email": "radia@gov.example", "role": "SECURITY_ADMIN", "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "Elizebeth Friedman", "email": "eliz@gov.example", "role": "SECURITY_ADMIN", "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" }
    ],
    "pools": [
      { "poolType": "SYSTEM_ADMIN",   "members": ["ada@gov.example", "grace@gov.example"] },
      { "poolType": "SECURITY_ADMIN", "members": ["radia@gov.example", "eliz@gov.example"] }
    ],
    "shares": [
      { "holderLabel": "Vault A (cold)", "isColdStored": true },
      { "holderLabel": "Vault B (cold)", "isColdStored": true }
    ]
  }'
```

- `members` are **emails** that must appear in `roster`; `m = members.length`,
  and `k` defaults to the majority (override with `"k": <int>`).
- `shares` is **metadata only** (holder labels / cold-storage flags). Shamir
  share material and the secret itself are **never** sent to or stored by the API.

### Providing the secret safely

The secret is **never** accepted on the command line / argv. Supply it via:
- `GENESIS_SECRET` environment variable, or
- `--secret-file <path>` to the genesis CLI.

The server accepts the request only if `sha256(secret)` equals the configured
`GOVERNANCE_GENESIS_COMMITMENT` (constant-time compare).

---

## 4. The proposal lifecycle (applies to all 8 proposal actions)

```
POST /governance/proposals                      → file    (returns { id, status: "PENDING" })
POST /governance/proposals/:id/approve          → approve (step-up; repeat until quorum)
POST /governance/proposals/:id/object           → object  (optional; halts at threshold)
POST /governance/proposals/:id/execute          → execute (step-up; applies the change)
GET  /governance/proposals            (?filters) → list
GET  /governance/proposals/:id                   → detail (with approvals + objections)
```

**File** — the proposer must be eligible for the governing pool (a member, or an
eligible cross-tier co-signer):

```bash
curl -sX POST http://localhost:3000/api/v1/governance/proposals \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{ "actionType": "APPOINT_ORG_ADMIN", "payload": { "org": "metro-pd", "userId": "<uuid>" } }'
```

**Approve** — one fresh step-up token per voter. Repeat with *different* pool
members until quorum is reached:

```bash
curl -sX POST http://localhost:3000/api/v1/governance/proposals/$ID/approve \
  -H "authorization: Bearer $ACCESS" -H "x-step-up-token: $STEPUP" \
  -H 'content-type: application/json' -d '{}'
```

Reusing a step-up token → `409`. Voting twice as the same person → `409`.

**Object** — an eligible reviewer can halt instead of approve. Once
`GOVERNANCE_MIN_OBJECTORS_TO_HALT` objections land, the proposal flips to
`OBJECTED` and can no longer be approved or executed:

```bash
curl -sX POST http://localhost:3000/api/v1/governance/proposals/$ID/object \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{ "reason": "target user left the org last week" }'
```

**Execute** — re-derives quorum from the real approval rows, checks any delay
window has elapsed, then applies the mutation + writes the audit row:

```bash
curl -sX POST http://localhost:3000/api/v1/governance/proposals/$ID/execute \
  -H "authorization: Bearer $ACCESS" -H "x-step-up-token: $STEPUP2" \
  -H 'content-type: application/json' -d '{}'
```

Common execute rejections: `quorum not met: X/Y in-pool approvals`,
`a cross-tier co-sign is required`, `X/Y auditor votes`, or
`proposal delay window has not elapsed`.

---

## 5. Action reference

Each action's `targetPool` is the pool that **votes**. The pool being *changed*
is created/reconstituted inside execute where different.

| actionType | Who votes (target pool) | Cross-tier co-sign | Extra quorum | Delay | Payload |
|---|---|---|---|---|---|
| `APPOINT_ORG_ADMIN` | `ORG_ADMIN` (of `org`) | Security Admin (≥1) | — | 0 | `{ org, userId }` |
| `REMOVE_ORG_ADMIN` | `ORG_ADMIN` (of `org`) | Security Admin (≥1) | — | 0 | `{ org, userId }` |
| `CHANGE_POOL_THRESHOLD` | the affected pool | Security Admin (≥1) | — | 0 | `{ poolType, org?, k }` |
| `APPOINT_SYSTEM_ADMIN` | `SYSTEM_ADMIN` | Security Admin (≥1) | — | 0 | `{ userId }` |
| `REMOVE_SYSTEM_ADMIN` | `SYSTEM_ADMIN` | Security Admin (≥1) | — | 0 | `{ userId }` |
| `ONBOARD_ORG` | `SYSTEM_ADMIN` | Security Admin (≥1) | — | 0 | `{ org, members[], k? }` |
| `CHANGE_ABAC_POLICY` | `SECURITY_ADMIN` | **System Admin (k-of-N)** | — | 0 | `{ policy }` |
| `POOL_REINSTATEMENT` | `SYSTEM_ADMIN` | Security Admin (≥1) *only if affected pool is `ORG_ADMIN`* | **k-of-P Auditors** | 72h | `{ poolType, org?, members[], k? }` |
| `GENESIS_REPLACEMENT` | — (not a proposal) | — | — | — | use `POST /governance/regenesis` |

`members[]` are **user UUIDs** (not emails — unlike bootstrap).

### 5.1 APPOINT / REMOVE_SYSTEM_ADMIN

Add or drop a member of the top-tier `SYSTEM_ADMIN` pool. Appoint grows `m` by 1
(keeping `k`); remove shrinks it, and is **blocked** if it would push the pool
below its quorum (`newM < 2` or `k > newM`) — lower `k` via
`CHANGE_POOL_THRESHOLD` first. Total top-tier loss is *not* recoverable here; use
`regenesis`.

```json
{ "actionType": "APPOINT_SYSTEM_ADMIN", "payload": { "userId": "<uuid>" } }
```

### 5.2 ONBOARD_ORG

Stand up a brand-new `ORG_ADMIN` pool + its roster in one execute. Rejected if a
pool for that `org` already exists; every member must be an **active** user.

```json
{ "actionType": "ONBOARD_ORG",
  "payload": { "org": "pune-cyber", "members": ["<uuid-1>", "<uuid-2>", "<uuid-3>"], "k": 2 } }
```

### 5.3 CHANGE_ABAC_POLICY (inverted quorum)

Filed against the `SECURITY_ADMIN` pool (Security Admin is primary), and requires
**k-of-N System-Admin acknowledgement** as the cross-tier quorum. The `policy` is
an **override document** layered on the hardcoded defaults — see §6.

```json
{ "actionType": "CHANGE_ABAC_POLICY",
  "payload": { "policy": {
    "permissionsByRole": { "RECORDS_ADMIN": ["document:read", "document:write", "user:read", "case:read"] }
  } } }
```

On execute a new `abac_policies` version (`MAX(version)+1`) is inserted and the
policy cache is invalidated **after commit**, so the new rules take effect within
seconds.

### 5.4 POOL_REINSTATEMENT (Tier-2 recovery)

Reinstate a pool that dropped **below its own quorum**. Governed by the
`SYSTEM_ADMIN` pool + a **k-of-P Auditor quorum** (P = active `AUDITOR`-role
users; **P = 0 fails closed** — provision auditors before you need recovery).
Subject to a **72-hour delay window** (`GOVERNANCE_DEFAULT_DELAY_HOURS`) before
execute is permitted.

- Affected `ORG_ADMIN` → a Security-Admin co-sign is *also* required.
- Affected `SECURITY_ADMIN` → **no** Security co-sign (that pool may be the
  casualty); System-Admin + Auditor quorums carry it.
- `poolType: "SYSTEM_ADMIN"` is rejected → that is the Tier-3 `regenesis` path.

```json
{ "actionType": "POOL_REINSTATEMENT",
  "payload": { "poolType": "ORG_ADMIN", "org": "metro-pd",
               "members": ["<uuid-1>", "<uuid-2>"], "k": 2 } }
```

Execute reconciles the pool to `members` (creates it if fully dissolved; else
adds/removes to match), then sets `(k, m)`. **Auditors vote** via the same
`/approve` endpoint (an active `AUDITOR` is auto-classified as an `AUDITOR_VOTE`
on auditor-quorum actions).

---

## 6. The ABAC policy overlay in detail

The active policy = hardcoded `DEFAULT_POLICY` **deep-merged** with the highest
`version` row in `abac_policies`. **No row ⇒ defaults verbatim** (behavior
identical to before the overlay existed).

An override document may carry **only** these four top-level keys (any other key
is rejected at file time):

| Key | Type | Merge behavior |
|---|---|---|
| `clearanceRank` | object `{LEVEL: number}` | per-entry (add/override individual levels) |
| `elevatedCaseRoles` | array of role strings | **replaces wholesale** |
| `permissionAliases` | object `{action: [alias...]}` | per-entry |
| `permissionsByRole` | object `{ROLE: [permission...]}` | per-entry |

Example — grant `PROSECUTOR` an extra permission and add a clearance level,
leaving everything else untouched:

```json
{ "policy": {
    "permissionsByRole": { "PROSECUTOR": ["case:read", "document:read", "document:sign", "document:download"] },
    "clearanceRank": { "TOP_SECRET": 4 }
} }
```

Because object-valued keys merge per-entry, you restate only the roles/levels you
change. `elevatedCaseRoles` is the exception — send the full list when you set it.

**History = audit trail.** The table is append-only (no UPDATE/DELETE); each
change is a new version, so the policy's entire evolution is inspectable.

---

## 7. Tier-3 recovery: `regenesis`

When the **entire** top tier (`SYSTEM_ADMIN` + `SECURITY_ADMIN`) is locked out,
no healthy pool remains to vote — so recovery is **not** a proposal. Instead a
fresh **share-authorized ceremony** replaces the top-tier pool *memberships*.

- Endpoint: `POST /governance/regenesis` (unauthenticated, before `requireAuth`).
- Gated by the **same** constant-time genesis commitment as bootstrap.
- Precondition: pools **already exist** (you are replacing, not founding).
- Only `SYSTEM_ADMIN` / `SECURITY_ADMIN` pools may be listed; `ORG_ADMIN` pools
  are left intact.
- It **never** touches the secret, the commitment, or genesis-share metadata.
- The secret is supplied exactly as in bootstrap (env / `--secret-file`, never argv).

```bash
curl -sX POST http://localhost:3000/api/v1/governance/regenesis \
  -H 'content-type: application/json' \
  -d '{
    "secret": "<the-founding-secret>",
    "roster": [
      { "fullName": "New SA1", "email": "sa1@gov.example", "role": "SYSTEM_ADMIN",   "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "New SA2", "email": "sa2@gov.example", "role": "SYSTEM_ADMIN",   "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "New SEC1","email": "sec1@gov.example","role": "SECURITY_ADMIN", "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" },
      { "fullName": "New SEC2","email": "sec2@gov.example","role": "SECURITY_ADMIN", "org": "hq", "clearance": "SECRET", "jurisdiction": "fed" }
    ],
    "pools": [
      { "poolType": "SYSTEM_ADMIN",   "members": ["sa1@gov.example", "sa2@gov.example"] },
      { "poolType": "SECURITY_ADMIN", "members": ["sec1@gov.example", "sec2@gov.example"] }
    ]
  }'
```

A commitment mismatch → `403`. Calling it before bootstrap → `409`.

---

## 8. End-to-end worked example: appoint a new System Admin

```bash
API=http://localhost:3000/api/v1

# 1. A SYSTEM_ADMIN member files the proposal.
ID=$(curl -sX POST $API/governance/proposals \
  -H "authorization: Bearer $ADA" -H 'content-type: application/json' \
  -d '{ "actionType": "APPOINT_SYSTEM_ADMIN", "payload": { "userId": "'$NEW_USER'" } }' \
  | jq -r .id)

# 2. Reach in-pool quorum (k=2): Ada + Grace each approve with a FRESH step-up token.
curl -sX POST $API/governance/proposals/$ID/approve -H "authorization: Bearer $ADA"   -H "x-step-up-token: $ADA_STEPUP"   -d '{}' -H 'content-type: application/json'
curl -sX POST $API/governance/proposals/$ID/approve -H "authorization: Bearer $GRACE" -H "x-step-up-token: $GRACE_STEPUP" -d '{}' -H 'content-type: application/json'

# 3. Cross-tier co-sign: a Security Admin approves.
curl -sX POST $API/governance/proposals/$ID/approve -H "authorization: Bearer $RADIA" -H "x-step-up-token: $RADIA_STEPUP" -d '{}' -H 'content-type: application/json'

# 4. Execute (fresh step-up). Applies membership + writes SUDO_EXECUTED audit row.
curl -sX POST $API/governance/proposals/$ID/execute -H "authorization: Bearer $ADA" -H "x-step-up-token: $ADA_STEPUP2" -d '{}' -H 'content-type: application/json'

# 5. Verify.
curl -s $API/governance/proposals/$ID -H "authorization: Bearer $ADA" | jq '.status, .approvals'
```

---

## 9. Configuration knobs

| Env var | Meaning | Used by |
|---|---|---|
| `GOVERNANCE_ENABLED` | master switch; `false` → all governance ops `403` | every action |
| `GOVERNANCE_GENESIS_COMMITMENT` | `sha256(secret)` hex; gates bootstrap + regenesis | bootstrap / regenesis |
| `GOVERNANCE_DEFAULT_DELAY_HOURS` | execute delay window (72) | `POOL_REINSTATEMENT` |
| `GOVERNANCE_MIN_OBJECTORS_TO_HALT` | objections needed to flip a proposal to `OBJECTED` | `object` |

---

## 10. Errors you'll actually hit

| HTTP | Message (substring) | Cause |
|---|---|---|
| 400 | `target pool does not exist` | filing against a pool that isn't set up yet |
| 400 | `payload.<field> is required` / `unknown key` | payload failed the registry shape guard |
| 403 | `not eligible to propose/approve/execute` | actor isn't in the governing or cross-tier pool |
| 403 | `step-up token is missing its jti` | approve/execute without a step-up token |
| 403 | `genesis secret does not match commitment` | bad secret on bootstrap/regenesis |
| 409 | `already voted` / `step-up token has already been used` | duplicate vote / replayed token |
| 409 | `quorum not met: …` | not enough in-pool / cross-tier / auditor approvals |
| 409 | `proposal delay window has not elapsed` | executing a Tier-2 reinstatement early |
| 409 | `governance has already been bootstrapped` | second bootstrap call |

---

## 11. Migrations & tests (developer notes)

- The overlay adds **one** table (`abac_policies`) and **zero** enum changes.
  Apply with `npm run migrate` — never `db:generate` (hand-written SQL +
  `_journal.json` entry only).
- Pure-logic tests (`node --test`):
  `node --test src/governance/sudoActions.test.js src/lib/abacPolicy.test.js`
  (needs any `DATABASE_URL` set, e.g. `DATABASE_URL=postgres://x@localhost/x`).
- HTTP/contract tests (Jest):
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand test/governance.route.test.js`.
- Do **not** run the `node --test` files under Jest (Jest can't parse `node:test`).
