import { Queue } from "bullmq";
import config from "../config/index.js";
import { connection } from "./connection.js";

// Producer side of the post-upload document-intelligence pipeline (DESIGN §11):
// ClamAV -> text extraction / PaddleOCR -> NER -> auto-tagging, driving
// document_versions.processing_status through
// SCANNING -> EXTRACTING -> INDEXING -> TAGGING -> READY (or QUARANTINED/FAILED).
// Mirrors src/jobs/ledger.queue.js. The consumer lives in
// documentProcessing.processor.js and runs in src/worker.js.
export const documentProcessingQueue = new Queue(config.processing.queueName, { connection });

/**
 * Enqueue one processing job for a freshly-committed document version.
 *
 * MUST be called AFTER the DB transaction commits so the worker is guaranteed to
 * find the row. FAIL-OPEN: a Redis/enqueue error is swallowed and logged so a
 * broker hiccup can never fail an upload — the row simply stays SCANNING for the
 * worker's reconciliation sweep to pick up. `jobId = versionId` makes the
 * enqueue idempotent (a retried request / a reconcile re-enqueue collapse onto
 * the same job) and lets a re-run safely upsert its own results.
 *
 * @param {{
 *   versionId: string, documentId: string, caseId: string, actor: string,
 *   storageKey: string, mimeType: string,
 * }} data
 * @returns {Promise<import("bullmq").Job|null>}
 */
export async function enqueueDocumentProcessing(data) {
  if (!config.processing.enabled) return null;
  try {
    return await documentProcessingQueue.add("process", data, {
      jobId: data.versionId,
      attempts: config.processing.attempts,
      backoff: { type: "exponential", delay: config.processing.backoffMs },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  } catch (err) {
    console.error(
      `[processing] enqueue failed for version ${data.versionId}; leaving SCANNING:`,
      err?.message ?? err,
    );
    return null;
  }
}
