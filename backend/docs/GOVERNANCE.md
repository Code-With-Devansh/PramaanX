# DMS Governance & Admin Hierarchy — Architecture

Companion to `DESIGN.md` §7 (Governance & Admin Model). This document specifies
**how the admin hierarchy is bootstrapped, how it governs itself day-to-day, and
how it recovers when parts of it become unreachable.**

---

## 1. Design principles (restated, made concrete)

1. **No single actor can create, appoint, or remove privileged identities alone.**
   Every irreversible or privilege-altering action requires quorum from peers,
   never a unilateral admin action.
2. **Recovery always escalates up a tier — never lowers the bar at the same tier.**
   A pool that can't reach its own quorum is fixed by the tier above it, not by
   redefining its own threshold.
3. **Every privileged action is logged, including the ones that failed or were
   objected to.** The audit chain is the permanent record of who governed the
   system, not just who touched documents.
4. **Recovery is rare, slow, and loud.** Every emergency path includes a mandatory
   delay and a broadcast objection window before it executes.
5. **The Auditor role never approves or blocks — it only witnesses.** Its presence
   is what makes emergency actions independently checkable after the fact, and
   (per the recovery rules below) its **quorum vote is a required precondition**
   for the highest-severity recovery actions, distinct from approval.

---

## 2. Hierarchy

```
Initial administrators (created once, at bootstrap)
├── System Admin        × N   — infra, deploys, backups. NO case/document access.
├── Security Admin      × 1+  — roles, ABAC policy, thresholds. NO case/document access.
├── Org Admin (per org) × M   — provisions/manages users within their own org
│     e.g. Pune Police Org Admin pool: M_pune admins, threshold k_pune
└── Auditor             × P   — read-only across ALL activity. Cannot approve/block
                                 anything except the mandatory quorum vote defined
                                 in §5 (recovery).
```

Everything below System Admin / Security Admin / Org Admin / Auditor —
Investigating Officers, Supervisors, Prosecutors, Judges, Forensic Analysts,
Records Admins, ordinary case users — is provisioned **afterward**, by an Org
Admin, through the normal (non-sudo) provisioning flow. This document only
covers the admin tiers themselves.

---

## 3. Action classes: sudo vs. normal

| Class | Definition | Approval model |
|---|---|---|
| **Normal** | Reversible, scoped, within an admin's ordinary job function — e.g. assign a case to a user, set a user's role-on-case, disable a non-admin user, reset a non-admin user's MFA. | Single admin, acting within their own scope. Fully logged. |
| **Sudo** | Creates, removes, or re-scopes *privileged identities or the rules that govern them* — e.g. appoint/remove an admin (any tier), change a pool's quorum threshold `k`, onboard a new org, change ABAC policy, escalate/de-escalate clearance ceilings. | Requires **k-of-m quorum** from the relevant pool (see §4), each approval individually authenticated (MFA/step-up). Cannot be approved by multiple sessions of the same person. |

Rule of thumb: **if the action changes who has power, or what power means, it's
sudo.** If it operates within power that's already correctly assigned, it's
normal.

---

## 4. Quorum rules

- Every pool (System Admins, Org Admins per org) has a size `m` and a threshold
  `k`, where **`k = floor(m/2) + 1` by default** (strict majority), with a hard
  floor of **`k ≥ 2`** even when `m` is small — no pool is ever single-controlled,
  even transiently.
- **Changing `k` or `m` for a pool is itself a sudo action**, and per §6, it
  cannot be approved purely from within the pool it affects — it requires the
  cross-tier co-signer described below. Otherwise a pool could quietly vote
  itself down to `k=1`.
- Each approval must come from a distinct, freshly authenticated admin session
  (MFA/step-up required per vote, not just per login) — enforced so that one
  compromised or coerced person cannot supply multiple "votes."

---

## 5. Cross-tier checks (sudo actions require more than in-pool quorum)

In-pool quorum alone is not sufficient for the highest-stakes sudo actions,
because a colluding or compromised majority within one pool would otherwise have
no external check. The following require a **cross-tier co-signer** in addition
to in-pool quorum:

| Sudo action | In-pool quorum | + Cross-tier co-sign |
|---|---|---|
| Appoint/remove an Org Admin within an existing org | k-of-m of that org's Org Admins | Security Admin sign-off |
| Appoint/remove a System Admin | k-of-N System Admins | Security Admin sign-off |
| Change a pool's `k` or `m` | k-of-m of that pool | Security Admin sign-off |
| Onboard a brand-new org (no existing Org Admin pool to vote) | — (pool doesn't exist yet) | k-of-N System Admins **+** Security Admin, jointly |
| Change ABAC policy / classification rules | — | Security Admin (their designated function per §7 of `DESIGN.md`) + k-of-N System Admin acknowledgement (infra impact) |

This mirrors Fabric's own endorsement-policy model (multi-org approval for
sensitive transactions) and is the intended long-term implementation path —
see §8.

---

## 6. Bootstrap (genesis)

Bootstrap is the one moment where no quorum can yet exist, because no admins
exist yet. It is treated as a **single, witnessed, one-time ceremony**, not a
standing feature of the system.

1. A founding secret is generated once and split via **Shamir's Secret Sharing**
   into N shares with threshold K (K-of-N), distributed to **organizationally
   distinct** parties over **separate channels** (no two shares travel the same
   path; none are stored server-side after distribution).
2. Reconstructing the secret (K of N shares, combined live, in a witnessed
   session — not automated) authorizes exactly one action: signing a single
   **genesis manifest** listing the entire initial roster in one atomic act —
   all System Admins, the Security Admin, all initial Org Admins, and all
   Auditors, with their pools' initial `k`/`m` values.
3. That manifest becomes **audit entry #0** — the first row in the hash-chained
   audit log, so the ledger's root of trust documents its own creation rather
   than starting mid-story with an unexplained initial roster.
4. The bootstrap mechanism **permanently disables itself** once genesis entry #0
   is written (enforced atomically — e.g. "the admins table is non-empty" is a
   hard precondition failure for ever running bootstrap again).
5. **The K-of-N genesis shares are not discarded after use.** They are returned
   to cold storage and become the system's permanent last-resort recovery root
   — see §7.3 (Tier 3 recovery).

---

## 7. Recovery

Recovery is split into three distinct scales. Collapsing them into one
mechanism is the primary risk to avoid — each tier is handled by the tier
**above** it, never by the affected pool lowering its own bar.

### 7.1 Tier 1 — a single admin loses personal access
*(lost device, lost MFA, forgotten credentials — the admin's identity is not in
question, just their current access to it.)*

Not a quorum event. Resolved as a **normal** action by any one remaining peer in
the same pool: re-enrolls the affected admin's MFA / issues a credential reset,
identical in mechanism to ordinary user recovery. Fully logged. No escalation,
no delay window — this is routine.

### 7.2 Tier 2 — a pool drops below its own quorum
*(e.g. an Org Admin pool goes from `m=5` to `1`, below `k=3` — the pool can no
longer vote on anything, including reinstating itself.)*

Escalates **one tier up**, resolved jointly by:

- **k-of-N System Admins**, plus
- **Security Admin** sign-off, plus
- **a minimum of k auditors voting** — the Auditor pool's own quorum, cast as
  votes (not mere observation) attesting that the lockout claim and the
  proposed reinstatement roster appear legitimate against the audit trail they
  can see. Auditors still cannot *originate* or *approve the substance* of the
  appointment — their vote is a required, separate precondition alongside the
  System Admin/Security Admin approval, not a stand-in for it.

Process:
1. A System Admin (or Security Admin) files a **Pool Reinstatement Proposal**
   naming the affected pool and the proposed new roster.
2. The proposal enters a **mandatory delay window (48–72h)**, broadcast to
   every active admin and every Auditor across the system: *"Pune Org Admin
   pool is being reconstituted — object now if this is not legitimate."*
   Any active admin outside the process, at any tier, may file an objection
   during this window, which halts execution pending manual review.
3. If no valid objection is raised, execution requires: k-of-N System Admin
   approval **+** Security Admin sign-off **+** k-of-P Auditor votes, all
   logged individually.
4. The reinstated pool immediately regains normal self-governance (§4) —
   this escalation path is not a standing override, it fires once per lockout
   event and closes.

The delay-plus-broadcast-objection pattern is deliberate: it's the same shape
used for account-recovery overrides at registrars/banks, and it turns the
recovery action itself into a durable, independently checkable part of the
audit trail rather than a quiet backdoor.

### 7.3 Tier 3 — the top tier itself is gone
*(System Admins AND Security Admin are simultaneously locked out — no
in-system authority remains to escalate to.)*

No quorum inside the system can resolve this; there is nothing left to
escalate *up* to within the running system. Resolution uses the **cold-stored
genesis shares from bootstrap (§6)**:

1. The K-of-N founding secret shares — held by parties who are **structurally
   outside day-to-day system operation** (e.g. external legal counsel, an
   independent oversight body, a party who has never held an active admin
   account) — are reconstructed, live, in a witnessed session.
2. Reconstruction authorizes a **fresh genesis-style ceremony**: a new signed
   manifest appointing a replacement top-tier roster (System Admins + Security
   Admin), written as a new dated audit entry that explicitly references and
   supersedes the prior top-tier roster.
3. This path carries no delay window by construction — the ceremony's slowness
   (assembling K of N structurally-independent, non-operational parties) is
   itself the friction that prevents casual misuse. It should still be treated
   as maximally rare and be followed by a full post-incident audit review once
   the system is governable again.
4. This is the system's genuine last resort: if the genesis shares themselves
   are lost or all destroyed, the system has no path back to a governed state
   and must be considered to have failed closed. This should be treated as a
   fire-drill-tested procedure, not a document that's written once and never
   rehearsed — an untested recovery path is not a real recovery path.

### 7.4 Recovery summary table

| Tier | Trigger | Resolved by | Delay/broadcast? | Auditor role |
|---|---|---|---|---|
| 1 | One admin's personal access lost | Any peer in same pool (normal action) | No | None needed |
| 2 | A pool drops below its own `k` | k-of-N System Admins + Security Admin | Yes, 48–72h objection window | **k-of-P Auditor quorum vote required** |
| 3 | Top tier (System Admin + Security Admin) entirely gone | K-of-N cold-stored genesis shares, held externally | No delay by construction (assembly friction substitutes) | Post-incident audit review |

---

## 8. Implementation direction (not yet built — design note for later)

> **Implementation status (updated).** All nine sudo actions are now built on the
> Postgres proposal/voting machinery (not the Fabric-endorsement alternative
> sketched below, which remains a possible future spike). Live actions:
> `APPOINT_ORG_ADMIN`, `REMOVE_ORG_ADMIN`, `CHANGE_POOL_THRESHOLD`,
> `APPOINT_SYSTEM_ADMIN`, `REMOVE_SYSTEM_ADMIN`, `ONBOARD_ORG`,
> `CHANGE_ABAC_POLICY`, `POOL_REINSTATEMENT`. Mechanics chosen:
> - **System-admin tier + ONBOARD_ORG** are governed by the org-less
>   `SYSTEM_ADMIN` pool with a Security-Admin cross-tier co-sign; the new/affected
>   pool is created in the execute branch (no `fileProposal` change).
> - **CHANGE_ABAC_POLICY** uses an inverted quorum (Security-Admin primary +
>   k-of-N System-Admin acknowledgement) and writes an append-only, versioned
>   `abac_policies` row (active = MAX(version)); `authorize.js` / `user.mapper.js`
>   merge that overlay onto hardcoded defaults, so no policy row means behavior
>   identical to before. The policy cache is invalidated only after the tx commits.
> - **POOL_REINSTATEMENT** (Tier-2) is governed by the `SYSTEM_ADMIN` pool + a
>   k-of-P Auditor quorum sourced from active `users.role = 'AUDITOR'` (P=0 means
>   fail-closed), with the 72h `defaultDelayHours` window enforced. A Security-Admin
>   co-sign is required only when the affected pool is `ORG_ADMIN`. It rejects
>   `poolType = SYSTEM_ADMIN`, which is the Tier-3 path.
> - **GENESIS_REPLACEMENT** (Tier-3) is deliberately not a proposal. It is a
>   share-authorized re-ceremony (`POST /governance/regenesis`, a bootstrap sibling
>   gated on the same constant-time genesis commitment) that supersedes the
>   top-tier pool memberships. It never touches the secret, commitment, or
>   genesis-share metadata, and never accepts the secret on argv. Its registry entry
>   stays `{supported:false}` so it can never be filed as a normal proposal.
>
> Deferred enhancement: the Tier-2 BullMQ notification/broadcast worker (the audit
> log already records every step).


The quorum-voting model described here (§3–§7) maps closely onto **Hyperledger
Fabric endorsement policies**, which `DESIGN.md` §3 already commits to for
document integrity. Rather than building a bespoke Postgres proposal/voting
schema in parallel:

- `AppointAdmin` / `RemoveAdmin` / `ChangePoolThreshold` / `OnboardOrg` could be
  chaincode transactions, with each pool's k-of-m expressed as a native Fabric
  endorsement policy.
- "Who counts as a valid Org Admin for Pune" is then answered by the Fabric
  MSP/CA for that org, not by an editable database row — appointment and
  cryptographic identity issuance happen together instead of as two
  separately-consistent systems.
- Tier 2/3 recovery proposals, objection windows, and final votes would all be
  transactions on the same ledger, giving them the same tamper-evidence as
  document custody events — which is arguably more important for governance
  actions than for documents themselves.

This is a design decision worth a dedicated spike before committing to either
approach, not something to default into while building the document-management
core.

---

## 9. Open questions for a future revision

1. Should Tier 2's objection window differ in length by pool size or org
   criticality, or stay fixed at 48–72h across the board?
2. Should Auditors be structurally barred from ever holding a genesis share
   (to keep "witness" and "last-resort key holder" cleanly separate roles), or
   is overlap acceptable given Auditors already have no approval power?
3. How often should the Tier 3 fire drill be rehearsed, and who verifies it
   without actually reconstructing the real secret each time (e.g. a
   dry-run with disposable test shares)?
4. What happens if a Tier 2 reinstatement proposal is filed in bad faith by a
   System Admin acting alone before enough peers notice to object — is a
   single objector sufficient to halt, or should halting itself require a
   minimum number of objectors to prevent one compromised account from
   permanently blocking legitimate recovery?
