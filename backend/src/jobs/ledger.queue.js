import { Queue } from "bullmq";
import config from "../config/index.js";
import { connection } from "./connection.js";

// Producer side of the ledger-anchoring pipeline. Imported by the documents
// service; the matching consumer is src/worker.js. Constructing the Queue opens
// a Redis connection at import time — fine for the API, which already depends on
// Redis.
export const ledgerQueue = new Queue(config.ledger.queueName, { connection });

/**
 * Enqueue one anchor job for a freshly-committed document version.
 *
 * MUST be called AFTER the DB transaction commits, so the worker is guaranteed
 * to find the row. FAIL-OPEN: a Redis/enqueue error is swallowed and logged, so
 * a broker hiccup can never fail an upload — the row simply stays PENDING_LEDGER
 * for a future reconciliation sweep. `jobId = versionId` makes the enqueue
 * idempotent: a duplicate (e.g. a retried request) collapses onto the same job.
 *
 * @param {import("../ledger/types.js").RegisterVersionInput} data
 * @returns {Promise<import("bullmq").Job|null>} the job, or null when disabled/failed.
 */
export async function enqueueLedgerAnchor(data) {
  if (!config.ledger.enabled) return null;
  try {
    return await ledgerQueue.add("anchor", data, {
      jobId: data.versionId,
      attempts: config.ledger.attempts,
      backoff: { type: "exponential", delay: config.ledger.backoffMs },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  } catch (err) {
    console.error(
      `[ledger] enqueue failed for version ${data.versionId}; leaving PENDING_LEDGER:`,
      err?.message ?? err,
    );
    return null;
  }
}
