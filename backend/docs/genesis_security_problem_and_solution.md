# Genesis Bootstrap Security: Problem Analysis and Proposed Architecture

## 1. Executive Summary

The current genesis bootstrap design protects the endpoint by checking whether the supplied genesis secret hashes to the configured `GOVERNANCE_GENESIS_COMMITMENT`.

The check is cryptographically sound **only when the commitment is itself protected from unauthorized modification**.

The fundamental problem is:

> If an attacker gains sufficient control over the application server to modify the effective genesis commitment and restart/redeploy the service, the attacker can choose a new secret, calculate its SHA-256 hash, replace the configured commitment, and bootstrap the system without possessing any of the real Shamir shares.

Adding Shamir Secret Sharing alone does not solve this problem. Shamir protects the secret from being held by one person or one machine, but it does not protect a mutable server-side commitment.

The proposed architecture therefore separates two security responsibilities:

1. **Shamir Secret Sharing** protects the real genesis secret and requires a quorum of independent custodians to reconstruct it.
2. **An externally anchored authorization/signing mechanism** prevents a compromised application server from inventing a new genesis secret and commitment.

The recommended model is:

```text
                OFFLINE CUSTODIANS
             Share A  Share B  Share C  Share D
                \        |       |       /
                 \------- 3-of-4 ----------/
                           |
                    Genesis Ceremony
                           |
                  authorize bootstrap
                           |
                    signed authorization
                           |
                           v
                  Governance Application
                           |
                   verify authorization
                           |
                     initialize DB
```

The preferred design can avoid sending the reconstructed genesis secret to the application server at all.

---

# 2. Current Implementation

The current bootstrap controller/service accepts a request containing a `secret`:

```ts
export async function bootstrap(req, res) {
  const body = parse(bootstrapSchema, req.body);
  res.status(201).json(await service.bootstrap(body, req.ip));
}
```

The service checks the supplied secret by hashing it:

```ts
function commitmentMatches(secret) {
  const configured = config.governance.genesisCommitment;

  if (!configured) return false;

  const provided = createHash("sha256")
    .update(String(secret), "utf8")
    .digest("hex");

  if (provided.length !== configured.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(configured, "hex")
    );
  } catch {
    return false;
  }
}
```

The bootstrap service then rejects the request unless the supplied secret matches the configured commitment:

```ts
if (!commitmentMatches(secret)) {
  throw forbidden("genesis secret does not match commitment");
}
```

The project also contains genesis ceremony tooling that reads the complete secret from either:

```text
GENESIS_SECRET
```

or:

```text
--secret-file <path>
```

and sends the complete secret to the bootstrap API.

The existing `shares` values used by bootstrap are metadata such as:

```json
{
  "holderLabel": "Vault A (cold)",
  "isColdStored": true
}
```

These are not Shamir share material.

---

# 3. What the Commitment Actually Provides

The commitment mechanism works as follows:

```text
Genesis secret S
       |
       | SHA-256
       v
H = SHA256(S)
       |
       v
GOVERNANCE_GENESIS_COMMITMENT
```

When bootstrap is called:

```text
Supplied secret S'
       |
       | SHA-256
       v
H' = SHA256(S')
       |
       v
compare H' with configured commitment
```

The server accepts only when:

```text
H' == H
```

This is a valid commitment check.

However, it only proves that the supplied secret matches the **currently configured commitment**. It does not prove that the commitment itself is authentic if an attacker can replace it.

Therefore:

```text
Protected commitment + correct secret
        -> strong bootstrap gate

Attacker-controlled commitment + attacker-chosen secret
        -> bootstrap gate can be bypassed
```

---

# 4. The Core Attack

Assume the legitimate system was initialized with:

```text
Real secret = S_real
Commitment  = SHA256(S_real)
```

Suppose an attacker gains enough server access to modify the effective environment/configuration.

The attacker can choose:

```text
S_attack = "some secret chosen by the attacker"
```

Then calculate:

```text
C_attack = SHA256(S_attack)
```

The attacker changes:

```text
GOVERNANCE_GENESIS_COMMITMENT=C_attack
```

After restarting/redeploying the application, the server will evaluate:

```text
SHA256(S_attack) == C_attack
```

which is true.

The attacker can then submit:

```json
{
  "secret": "some secret chosen by the attacker",
  "roster": [...],
  "pools": [...]
}
```

and pass the commitment check.

## Why Shamir alone does not prevent this

Suppose the real secret has been split using 3-of-4 Shamir:

```text
S_real
  |
  +-- Share A
  +-- Share B
  +-- Share C
  +-- Share D
```

An attacker who controls only the application server may have none of these shares.

That is good: the attacker cannot reconstruct `S_real`.

But that does **not** stop the attacker from inventing another secret:

```text
S_attack
  |
  +-- SHA256
         |
         +-- replace server commitment
```

Therefore:

> Shamir protects the real secret, but the mutable commitment remains an independent trust problem.

---

# 5. Security Goals

The improved architecture should satisfy the following properties.

## Goal 1: No single custodian possesses the complete secret

Use a threshold such as 3-of-4:

```text
4 total shares
3 required to reconstruct
```

A single lost or compromised share must not reveal the genesis secret.

## Goal 2: The application server does not persist the secret

The secret must not be stored in the database, ordinary configuration, logs, or persistent files.

## Goal 3: A server compromise alone must not authorize a new genesis

An attacker who controls the application server but does not control the independent genesis trust domain must not be able to invent a new secret and bootstrap using it.

## Goal 4: Bootstrap must be one-time

The existing database-side protection that prevents a second initialization should remain in place.

## Goal 5: Custodians remain independently controlled

The threshold should require cooperation between separate holders rather than a single administrator.

---

# 6. Why Simply Sending Shamir Shares to the Server Is Not the Best Solution

A straightforward modification would be:

```text
POST /bootstrap
{
  "shares": [shareA, shareB, shareC]
}
```

and then in the service:

```ts
const secret = shamirCombine(shares);

if (!commitmentMatches(secret)) {
  throw forbidden(...);
}
```

This is better than storing the shares in the database, but it has a major limitation:

> Once the server receives enough shares, the server can reconstruct the complete secret.

The reconstructed secret then exists in application memory during the request.

If the application server is compromised at the right time, an attacker may be able to capture the secret.

Therefore, sending all shares to the ordinary application server does not provide the strongest possible security boundary.

---

# 7. Recommended Architecture

Use two independent security mechanisms:

## A. Shamir Secret Sharing

Protects the genesis secret.

Example:

```text
                 Real Genesis Secret
                         |
                     Shamir 3-of-4
                         |
        +----------------+----------------+
        |                |                |
     Share A          Share B          Share C        Share D
        |                |                |                |
     Vault A          Vault B          Vault C          Vault D
```

The actual share material is kept outside the application database.

## B. External Authorization / Signature

Protects the decision to bootstrap.

Instead of asking the application server to decide whether an arbitrary secret is valid based on a mutable environment variable, make the bootstrap ceremony produce a cryptographically verifiable authorization.

Conceptually:

```text
Custodian quorum
      |
      v
Genesis ceremony
      |
      v
Sign bootstrap authorization
      |
      v
Governance API
      |
      v
Verify signature using trusted public key
      |
      v
Bootstrap
```

The server should hold only the public verification key or another externally anchored verification value.

---

# 8. Stronger Variant: Do Not Send the Genesis Secret to the Server

The strongest approach for this architecture is to avoid transmitting the reconstructed secret to the ordinary governance API at all.

The flow becomes:

```text
Share A  ----\
Share B  -----+--> Genesis Ceremony
Share C  ----/          |
                         | 3-of-4 reconstruction
                         v
                  Genesis authorization
                         |
                         | sign authorization
                         v
                   signed payload
                         |
                         v
                 POST /bootstrap
                         |
                         v
                 verify signature
                         |
                         v
                  initialize system
```

The server receives an authorization object, not the secret.

---

# 9. What Should Be Signed

The authorization should be bound to the exact bootstrap operation rather than being a generic signature.

A payload could conceptually contain:

```json
{
  "purpose": "GOVERNANCE_GENESIS_BOOTSTRAP",
  "version": 1,
  "nonce": "unique-random-value",
  "issuedAt": "2026-08-31T12:00:00Z",
  "expiresAt": "2026-08-31T12:15:00Z",
  "rosterDigest": "...",
  "poolDigest": "..."
}
```

The ceremony signs the canonical serialization of this payload.

The server verifies:

1. Signature validity.
2. Trusted public key.
3. Purpose is exactly `GOVERNANCE_GENESIS_BOOTSTRAP`.
4. Authorization has not expired.
5. Nonce has not already been used.
6. The signed roster/pool digest matches the request.
7. Bootstrap has not already happened.

This prevents an authorization intended for one configuration from being replayed against another configuration.

---

# 10. Where the Shamir Secret Is Used

There are two possible designs.

## Design A: Shamir only for secret custody

```text
Shares
  |
  v
Reconstruct secret
  |
  v
Use secret in ceremony
```

This provides recovery/custody protection but still requires careful handling of the reconstructed secret.

## Design B: Shamir controls a signing key instead

This is generally stronger for the server architecture.

Instead of using Shamir to protect the actual application bootstrap secret, use a threshold ceremony around a key that is authorized to sign genesis operations.

Conceptually:

```text
Threshold-controlled private key
             |
      3-of-4 custodians
             |
             v
      genesis authorization
             |
         signature
             |
             v
       governance server
```

The governance server verifies signatures against a known public key.

This separates:

```text
Secret custody
```

from:

```text
Authorization to bootstrap
```

The exact cryptographic protocol should be selected based on the operational requirements. A basic Shamir reconstruction followed by signing can work, but a proper threshold-signature scheme can avoid reconstructing a long-lived private key in one process.

---

# 11. Trust Anchor Problem

The signature approach only works if the public verification key is itself trusted.

If the attacker can modify:

```text
TRUSTED_PUBLIC_KEY
```

the same fundamental attack returns.

Therefore the public key must be protected outside the attacker's control.

Possible approaches include:

- immutable deployment configuration
- signed application configuration
- cloud KMS/HSM-backed policy
- an independent control plane
- deployment infrastructure with separate administrative authority
- hardware-backed verification roots

The exact choice depends on the deployment environment.

The important principle is:

> The trust anchor must be in a security domain that is independent from the application server being protected.

---

# 12. Recommended Components

A practical implementation can be split into these components.

## 12.1 Governance API

Responsibilities:

- validate bootstrap request
- verify genesis authorization signature
- validate signed request digest
- enforce one-time bootstrap
- execute database transaction
- record audit information

It should not:

- store Shamir shares
- reconstruct the Shamir secret
- persist the complete genesis secret
- accept an arbitrary attacker-selected commitment

## 12.2 Genesis Ceremony CLI

Responsibilities:

- obtain authenticated shares from custodians
- verify share format
- enforce the required threshold
- construct the exact bootstrap authorization payload
- create the authorization signature
- send the signed bootstrap request
- erase temporary secret/key material as far as the runtime permits

## 12.3 Custodian Storage

Responsibilities:

- hold individual Shamir shares
- keep shares physically/logically separate
- require multiple custodians for recovery/authorization

The application database should store only metadata about custodians, not share material.

---

# 13. Suggested Request Model

Instead of:

```json
{
  "secret": "...",
  "roster": [...],
  "pools": [...]
}
```

prefer something conceptually like:

```json
{
  "roster": [...],
  "pools": [...],
  "authorization": {
    "keyId": "genesis-key-1",
    "algorithm": "...",
    "payload": {
      "purpose": "GOVERNANCE_GENESIS_BOOTSTRAP",
      "nonce": "...",
      "issuedAt": "...",
      "expiresAt": "...",
      "rosterDigest": "...",
      "poolDigest": "..."
    },
    "signature": "..."
  }
}
```

The server then checks:

```ts
verifyAuthorization(authorization, trustedGenesisPublicKey);
```

and independently verifies that:

```text
SHA256(canonical(roster)) == authorization.payload.rosterDigest
SHA256(canonical(pools))  == authorization.payload.poolDigest
```

This prevents the authorization from being copied and attached to a modified request.

---

# 14. Replay Protection

A signed authorization should not be reusable indefinitely.

Use:

```text
nonce + expiration + one-time database record
```

For example:

```text
Authorization issued: 12:00
Expires:              12:15
Nonce:                random 256-bit value
```

The server records the nonce when it consumes the authorization.

A second request with the same authorization should fail.

---

# 15. Handling the Current `GOVERNANCE_GENESIS_COMMITMENT`

The existing commitment can remain useful as an additional defense if the actual genesis secret is still used internally.

However, it should not be the sole root of trust if it is stored in a mutable environment variable that an attacker can change.

Two reasonable options are:

## Option 1: Keep commitment as secondary validation

```text
signed authorization
        |
        v
accept bootstrap
        |
        +--> optional commitment verification
```

## Option 2: Replace commitment-based bootstrap with signature-based authorization

```text
trusted public key
       |
       v
verify authorization
       |
       v
bootstrap
```

Option 2 provides the cleaner security model when the goal is to protect bootstrap from a compromised application server.

---

# 16. What This Protects Against

## Attacker has database access only

They should not obtain:

- Shamir shares
- genesis private key
- valid bootstrap authorization

Therefore database access alone should not allow creation of a new genesis state.

## Attacker has application server access

They may be able to alter application behavior, but they should not be able to generate a valid genesis authorization unless they can also compromise the independent authorization trust domain.

## Attacker has one Shamir share

One share should reveal nothing useful about the complete secret under the assumed threshold scheme.

## Attacker has fewer than `k` shares

They should not be able to reconstruct the secret.

## Attacker has `k` or more shares

They can potentially reconstruct/authorize the operation. This is why the custodians and their storage must be independently protected.

---

# 17. What This Does NOT Protect Against

If an attacker obtains complete administrative control over **every security domain**, no application architecture can prevent compromise.

For example, if the attacker controls all of:

```text
application server
deployment system
KMS/HSM policy
all custodians
all Shamir shares
```

then the security boundary has been completely defeated.

The objective is instead to require compromise of multiple independent domains.

---

# 18. Operational Genesis Ceremony

A recommended operational procedure is:

```text
Step 1
Generate strong random secret/key material.

Step 2
Generate Shamir shares using the chosen threshold.

Step 3
Distribute shares to independent custodians.

Step 4
Store only share metadata in the governance database.

Step 5
Register/pin the trusted verification key in the deployment trust domain.

Step 6
For bootstrap, custodians participate in the ceremony.

Step 7
The ceremony creates the one-time authorization.

Step 8
The ceremony submits the signed bootstrap request.

Step 9
The server verifies the authorization and request digest.

Step 10
The server performs the one-time database initialization.

Step 11
Record an immutable audit event.

Step 12
Destroy temporary secret/key material used by the ceremony.
```

---

# 19. Important Implementation Details

## 19.1 Never log secrets or shares

Check:

- HTTP access logging
- request-body logging
- error logging
- tracing/APM
- debug logging
- shell history
- CI logs
- crash dumps

A secret that is not stored by the application can still leak through logs.

## 19.2 Do not place the complete secret in process arguments

Avoid:

```bash
node genesis.js --secret='...'
```

Prefer an interactive input mechanism, protected file descriptor, secure secret store, or controlled ceremony environment.

## 19.3 Avoid persistent secret files

If a file is unavoidable:

- restrict permissions
- place it on an encrypted volume
- remove it after use
- avoid backups/snapshots containing it

## 19.4 Canonicalize signed data

The exact bytes being signed and verified must be deterministic.

Do not sign arbitrary JSON where property order or serialization can vary.

Use a canonical serialization format or a deterministic digesting strategy.

## 19.5 Bind authorization to the requested bootstrap state

The authorization must cover:

```text
roster
pools
relevant governance parameters
nonce
expiry
purpose
```

Otherwise a valid authorization could be replayed with malicious modifications.

---

# 20. Relationship Between `k/m` Governance Threshold and Shamir Threshold

The application currently validates pool thresholds using concepts such as:

```text
m = number of pool members
k = required governance approvals
```

Do not automatically equate this with Shamir parameters.

For example:

```text
Governance quorum: 3 of 4 administrators
```

and:

```text
Shamir threshold: 3 of 4 custodians
```

may happen to use the same numbers, but they serve different purposes.

Governance quorum answers:

> How many authorized members must approve a governance action?

Shamir threshold answers:

> How many secret shares are required to reconstruct the secret?

They should be modeled independently unless the system explicitly intends them to be the same control.

---

# 21. Minimal Code-Level Refactoring

The safest incremental approach is:

## Current

```text
controller
    -> service.bootstrap({ secret, roster, pools })
        -> commitmentMatches(secret)
        -> initialize DB
```

## Recommended

```text
controller
    -> service.bootstrap({ roster, pools, authorization })
        -> verifyAuthorization(authorization)
        -> verify request digest
        -> verify one-time state
        -> initialize DB
```

Move Shamir handling to:

```text
scripts/genesis-ceremony/
```

rather than adding secret-share reconstruction to:

```text
src/controllers/
src/governance/bootstrap-service.ts
```

This preserves a clean separation between the ordinary application and the high-security ceremony.

---

# 22. Recommended Final Trust Model

The final architecture should look like this:

```text
                    SECURITY DOMAIN 1
                  Application Server
                  -------------------
                  Governance API
                       |
                 verifies signed
                  authorization
                       |
                       v
                    Database

                           ^
                           |
                           |
                    independent trust
                           |
                           |
                    SECURITY DOMAIN 2
                  Genesis Ceremony
                  -----------------
                       |
                3-of-4 custodians
                       |
             +---------+---------+
             |         |         |
           Share A   Share B   Share C   Share D
             |
             v
      threshold authorization
             |
             v
       signing operation
             |
             v
        signed request
```

A server compromise should therefore not be enough to create a valid genesis authorization.

---

# 23. Final Recommendation

Do **not** solve the problem by simply changing `/bootstrap` to accept all Shamir shares and combining them inside the ordinary application service.

That approach still exposes the complete secret to the application server during reconstruction.

Instead:

1. Keep Shamir share custody outside the application database.
2. Require a threshold of independent custodians for the genesis ceremony.
3. Perform secret/key handling in a dedicated ceremony process.
4. Prefer a signed one-time bootstrap authorization over sending the reconstructed secret to the application server.
5. Anchor the verification public key outside the mutable application environment.
6. Bind the authorization to the exact roster/pool configuration, a nonce, an expiry time, and a bootstrap-specific purpose.
7. Enforce one-time consumption server-side.
8. Keep the current database/advisory-lock protections.
9. Ensure secrets, shares, and authorization material never enter ordinary logs or persistent application storage.

The central security principle is:

> **Shamir protects the secret. An independent cryptographic trust anchor protects the authorization to bootstrap. Both are required if the application server itself must be treated as potentially compromised.**
