import { Queue } from "bullmq";
import { connection } from "./connection.js";

// Producer side of mention notifications. Unlike the live socket push
// (src/realtime/publisher.js), this needs at-least-once delivery — a missed
// mention notification is a real miss, not a "just refetch" situation — so it
// goes through BullMQ (retry + backoff), same shape as enqueueLedgerAnchor.
// The matching consumer belongs in src/worker.js alongside the ledger-anchor
// processor once notification delivery (email/in-app) is implemented.
export const mentionsQueue = new Queue("mention-notifications", { connection });

/**
 * Enqueue one notification job per mentioned user. MUST be called AFTER the
 * comment transaction commits. FAIL-OPEN: caller swallows enqueue errors (see
 * comments.service) so a broker hiccup never fails the comment itself.
 */
export async function enqueueMentionNotifications({ commentId, caseId, mentions, authorId }) {
  console.log(`Enqueuing mention notifications for comment ${commentId} in case ${caseId}:`, mentions);
  if (!mentions?.length) return [];
  return Promise.all(
    mentions.map((mentionedUserId) =>
      mentionsQueue.add(
        "notify-mention",
        { commentId, caseId, mentionedUserId, authorId },
        {
          jobId: `${commentId}-${mentionedUserId}`, // idempotent on retry/redelivery
          attempts: 5,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      ),
    ),
  );
}
