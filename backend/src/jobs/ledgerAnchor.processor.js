// Ledger-anchor job processing, as PURE factories over injected dependencies.
// There are deliberately NO top-level imports of the db, Redis, the ledger, or
// config here: src/worker.js wires the real singletons in, and tests wire fakes
// in, so this file exercises the full state-machine logic without any live infra.
//
// The anchor state machine on document_versions.ledger_status:
//   PENDING_LEDGER --(ledger accepts)--> ANCHORED   (+ ledger_tx_id, anchored_at)
//   PENDING_LEDGER --(retries exhausted)--> FAILED
// Each transition commits atomically with its audit-chain entry.

/**
 * Build the BullMQ processor: anchor a version's hash on the ledger, then mirror
 * the result into Postgres. A thrown ledger error propagates so BullMQ retries;
 * only after retries are exhausted does the worker's failure handler run
 * markAnchorFailed (below). registerDocumentVersion is idempotent at the seam, so
 * a retry that already anchored simply re-reads and re-mirrors — safe.
 *
 * @param {{
 *   ledger: import("../ledger/types.js").LedgerService,
 *   repo: typeof import("../repositories/documents.repo.js"),
 *   db: { transaction: (cb: (tx: any) => Promise<any>) => Promise<any> },
 *   recordAudit: Function,
 *   AuditAction: Record<string, string>,
 *   TargetType: Record<string, string>,
 * }} deps
 */
export function createLedgerAnchorProcessor({ ledger, repo, db, recordAudit, AuditAction, TargetType }) {
  return async function processLedgerAnchor(job) {
    const data = job.data;
    const { txId, record } = await ledger.registerDocumentVersion(data);
    // The ledger timestamp is epoch SECONDS; mirror it as a real Date.
    const anchoredAt = new Date(record.ts * 1000);

    await db.transaction(async (tx) => {
      await repo.setLedgerAnchored(tx, { versionId: data.versionId, ledgerTxId: txId, anchoredAt });
      await recordAudit(tx, {
        actorId: data.actor,
        action: AuditAction.VERSION_ANCHORED,
        targetType: TargetType.VERSION,
        targetId: data.versionId,
        ip: null,
        details: {
          docId: data.docId,
          caseId: data.caseId,
          versionNo: data.versionNo,
          sha256: data.sha256,
          ledgerTxId: txId,
          actorOrg: record.actorOrg,
          ledgerTs: record.ts,
        },
      });
    });

    return { versionId: data.versionId, txId };
  };
}

/**
 * Build the terminal-failure handler: after BullMQ exhausts all attempts, flip
 * the row to FAILED and write a VERSION_ANCHOR_FAILED audit entry so the
 * abandonment is itself on the chain. Same injected deps as the processor.
 */
export function createAnchorFailureHandler({ repo, db, recordAudit, AuditAction, TargetType }) {
  return async function markAnchorFailed(job, err) {
    const data = job.data;
    await db.transaction(async (tx) => {
      await repo.setLedgerFailed(tx, { versionId: data.versionId });
      await recordAudit(tx, {
        actorId: data.actor,
        action: AuditAction.VERSION_ANCHOR_FAILED,
        targetType: TargetType.VERSION,
        targetId: data.versionId,
        ip: null,
        details: {
          docId: data.docId,
          caseId: data.caseId,
          versionNo: data.versionNo,
          reason: String(err?.message ?? err),
        },
      });
    });
  };
}
