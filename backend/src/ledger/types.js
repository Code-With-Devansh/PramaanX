// LedgerService — the seam between the DMS backend and the Hyperledger Fabric
// integrity layer (the deployed `document` chaincode / DocumentContract). Docs
// only; JS has no interfaces, so these JSDoc typedefs are the contract that both
// createInMemoryLedgerService (now) and a future FabricLedgerService must honour.
//
// SECURITY: only hashes + lifecycle metadata cross this seam. Document bytes and
// PII never reach the ledger — callers pass a storageRef (object-store key) and a
// sha256, never the file itself.

/**
 * The on-chain record for one document version, as returned by the chaincode's
 * RegisterDocumentVersion / GetVersion (blockchain.md §4.1). The world-state key
 * is `versionId` (== Postgres document_versions.id), which joins ledger ↔ mirror.
 *
 * @typedef {Object} LedgerRecord
 * @property {"DocumentVersion"} docType   Discriminator for the on-chain value.
 * @property {string} versionId            World-state key; == document_versions.id.
 * @property {string} docId                Owning document id.
 * @property {string} caseId               Owning case id.
 * @property {number} versionNo            Monotonic per-document version number.
 * @property {string} sha256               64-char lowercase hex content fingerprint.
 * @property {"PUBLIC"|"RESTRICTED"|"CONFIDENTIAL"|"SECRET"} classification
 * @property {string} storageRef           Object-store key (pointer, not bytes).
 * @property {string} actor                Application user id that submitted it.
 * @property {string} actorOrg             MSP id from the signing cert (trusted).
 * @property {"ACTIVE"|"SEALED"|"LEGAL_HOLD"} status
 * @property {string} lastAction           Most recent lifecycle action.
 * @property {string} lastActor            Actor of the most recent action.
 * @property {string} [lastNote]           Optional note from the last custody event.
 * @property {number} ts                   Ledger timestamp in epoch SECONDS (not ms).
 */

/**
 * Payload to anchor a brand-new version. Mirrors the chaincode's
 * RegisterDocumentVersion payload; `actorOrg`/`status`/`ts` are set on-chain, not
 * by the caller.
 *
 * @typedef {Object} RegisterVersionInput
 * @property {string} versionId
 * @property {string} docId
 * @property {string} caseId
 * @property {number} versionNo
 * @property {string} sha256
 * @property {string} classification
 * @property {string} storageRef
 * @property {string} actor
 */

/**
 * Result of a write submission: the ledger transaction id plus the resulting
 * record. `alreadyRegistered` is true when the version was already anchored — the
 * seam treats a duplicate register as idempotent SUCCESS (not an error), so a
 * worker retry after a crash re-reads rather than fails.
 *
 * @typedef {Object} SubmitResult
 * @property {string} txId
 * @property {LedgerRecord} record
 * @property {boolean} [alreadyRegistered]
 */

/**
 * A lifecycle/custody event. `action` ∈ SIGNED | TRANSFERRED | SEALED |
 * LEGAL_HOLD | DISCLOSED | RESTORED.
 *
 * @typedef {Object} CustodyEventInput
 * @property {string} action
 * @property {string} actor
 * @property {string} [note]
 */

/**
 * One entry of the tamper-proof custody trail (chaincode GetDocumentHistory).
 *
 * @typedef {Object} HistoryEntry
 * @property {string} txId
 * @property {number} timestamp            Epoch SECONDS.
 * @property {boolean} isDelete
 * @property {LedgerRecord|null} value
 */

/**
 * The abstraction the anchor worker (and later, custody/seal endpoints) depend
 * on. Every method is async so the in-memory stub and the network-backed Fabric
 * client are interchangeable. Write methods (register/custody/seal) are
 * submissions; read methods (verify/get/history) are evaluations.
 *
 * @typedef {Object} LedgerService
 * @property {(input: RegisterVersionInput) => Promise<SubmitResult>} registerDocumentVersion
 * @property {(versionId: string, event: CustodyEventInput) => Promise<SubmitResult>} recordCustodyEvent
 * @property {(versionId: string, actor: string) => Promise<SubmitResult>} sealDocument
 * @property {(versionId: string, sha256: string) => Promise<{match: boolean, record: LedgerRecord|null}>} verifyHash
 * @property {(versionId: string) => Promise<LedgerRecord|null>} getVersion
 * @property {(versionId: string) => Promise<HistoryEntry[]>} getDocumentHistory
 * @property {() => Promise<void>} [close]  Release any underlying connection.
 */

export {};
