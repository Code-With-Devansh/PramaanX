# LexVault DMS — Frontend

Vite + React + Tailwind frontend for the legal document management system. Plain
Tailwind (no component library), wired to the real backend API — no mock data.

## Setup

```bash
npm install
cp .env.example .env   # set VITE_API_BASE_URL if the backend isn't on localhost:3000
npm run dev
```

The backend must be running (see the `dms/` folder) at the URL in `.env`
(defaults to `http://localhost:3000/api/v1`). CORS on the backend must allow
credentials from the frontend's origin, since auth relies on an httpOnly
refresh cookie.

## What's implemented

- **Auth**: username/password login -> mandatory MFA (TOTP) verification. First
  login for an account with no MFA enrolled routes to a QR-code enrollment flow.
  Access token is kept in memory only (never localStorage); the refresh token is
  an httpOnly cookie, silently refreshed on 401.
- **Step-up re-authentication**: sensitive actions (legal hold, seal, user
  edits/deactivation, session revocation) prompt for a fresh MFA code and
  attach the resulting `X-Step-Up-Token` header, matching the backend's
  `requireStepUp` middleware.
- **Cases**: list/search/filter, create, detail view, status changes, officer
  assignment, legal hold placement/release.
- **Documents**: upload (multipart), version history, add version, restore a
  prior version, download (presigned URL), integrity check (re-hash vs. ledger),
  chain-of-custody timeline, seal.
- **Users (admin)**: list/search/filter, provision, edit role/clearance/status,
  deactivate, reset MFA, view/revoke active sessions. Admin-tier roles
  (SYSTEM_ADMIN/SECURITY_ADMIN/ORG_ADMIN) are read-only here — the backend
  requires those go through `/governance` proposals, which this frontend does
  not implement.
- **Audit log**: filterable, paginated audit trail + a "verify chain integrity"
  action against `/audit/verify`.
- **Governance**: proposal list/filter, filing a proposal (dynamic form per
  `actionType` — appoint/remove admins, change a pool's quorum threshold,
  onboard a new org, change ABAC policy, reinstate a pool), proposal detail
  with approvals/objections, and Approve / Object / Execute actions
  (Approve/Execute require step-up, matching the backend). The UI shows what
  your role's permission allows; the server independently re-derives quorum
  and pool membership on every action, so a visible button is not a guarantee
  the action will succeed.
- **Access control**: the sidebar and action buttons are gated by the current
  user's permissions (from `/auth/me`), mirroring the backend's ABAC alias
  table so what you can click matches what the server will accept.

## Not implemented (out of scope for this pass)

- Governance **bootstrap** and **regenesis** ceremonies — these are
  intentionally left to the genesis CLI (see below), not the web app.
- `POST /auth/password` (change password) — no screen for it yet.
- `GET /documents/:id/versions/:vid` (single-version fetch) — the version
  list already covers what this would add.
- Case search by free-text beyond the basic `q` param; no saved views.
- Real-time/notification surfaces — everything is request/response.

## Governance: what's deliberately left out, and why

`POST /governance/bootstrap` and `POST /governance/regenesis` are **not**
wired into this frontend on purpose. Both routes sit *before* `requireAuth` in
the backend (no admin exists yet to authenticate as) and are gated by an
out-of-band secret commitment — the backend's own comments say they're
"intended to be reachable only over an admin-only channel," i.e. the genesis
CLI, not a browser form. Putting a "type your genesis secret here" field in a
web app would undercut the reason that secret is out-of-band in the first
place.

Everything else in `/governance` (list/file/get/approve/object/execute
proposals) is wired up.

**One backend gap worth knowing about**: `AUDITOR` is meant to cast
`AUDITOR_VOTE` approvals for `POOL_REINSTATEMENT` recovery, and has the raw
`governance:vote` permission — but `POST /governance/proposals/:id/approve`
(and object/execute) are gated by `authorize(..., "governance:approve")` at
the controller level, and there's no alias from `governance:vote` to
`governance:approve`. So an Auditor can never actually reach the service
logic that would classify them as `AUDITOR_VOTE` — the request is rejected
before it gets there. The frontend correctly hides the vote/execute panel for
Auditors (since the call would 403), but this looks like a real backend bug:
either `governance:vote` needs an alias, or auditors need `governance:approve`
too. Flagging it rather than silently working around it in the frontend.

## One backend quirk worth knowing

`DELETE /cases/:id/legal-hold` places the hold (takes a reason) and
`POST /cases/:id/legal-hold` releases it — the reverse of what the HTTP verbs
would suggest. The frontend calls it exactly as the backend routes it
(see `src/pages/cases/CaseDetail.jsx`), with a comment at the call site.

## Structure

```
src/
  lib/           axios client, auth context, step-up context, format helpers, permission aliases
  components/    shared UI (buttons, cards, badges), app shell, route guards
  pages/
    auth/        Login, MfaEnroll
    cases/       CasesList, CaseDetail, NewCaseDialog, AssignOfficerDialog
    documents/   DocumentDetail, UploadDocumentDialog, AddVersionDialog
    admin/       UsersList, UserDetail, NewUserDialog
    governance/  ProposalsList, ProposalDetail, NewProposalDialog
    Audit.jsx
```
