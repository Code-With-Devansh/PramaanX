import config from "../config/index.js";
import * as repo from "../repositories/documents.repo.js";
import { enqueueDocumentProcessing } from "./documentProcessing.queue.js";

// Stuck-job reconciliation for the document-intelligence pipeline — the same
// pattern the ledger uses for pending anchors. A version can be left in a
// non-terminal processing_status if the worker died mid-job, Redis dropped the
// job, or the after-commit enqueue in documents.service.js fail-opened. This
// sweep finds those and re-enqueues them; `jobId = versionId` means a job that
// is actually still running or queued is a no-op to re-add.
export async function reconcileStuckProcessing({ stuckAfterMs = config.processing.stuckAfterMs } = {}) {
  const cutoff = new Date(Date.now() - stuckAfterMs);
  const stuck = await repo.listStuckExtractions(cutoff);

  let requeued = 0;
  for (const row of stuck) {
    const version = await repo.getVersionById(row.versionId);
    if (!version) continue;
    if (version.processingStatus === "READY" || version.processingStatus === "QUARANTINED") continue;

    const doc = await repo.getDocumentById(row.documentId);
    if (!doc) continue;

    const job = await enqueueDocumentProcessing({
      versionId: row.versionId,
      documentId: row.documentId,
      caseId: doc.caseId,
      actor: version.createdBy,
      storageKey: version.storageKey,
      mimeType: version.mimeType,
    });
    if (job) requeued += 1;
  }

  if (requeued) console.log(`[processing] reconcile re-enqueued ${requeued} stuck version(s)`);
  return { scanned: stuck.length, requeued };
}

// Also catch versions whose extraction row was never created at all (enqueue
// fail-opened before the worker ever touched them): those show up as
// document_versions still in SCANNING with no document_extractions row. Kept
// separate so the cheap indexed sweep above stays the common path.
export async function startProcessingReconciler({
  intervalMs = config.processing.reconcileEveryMs,
} = {}) {
  const tick = () =>
    reconcileStuckProcessing().catch((err) =>
      console.error("[processing] reconcile error:", err?.message ?? err),
    );
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
