import redis from "../config/redis.js";

// Live-update signal ONLY — not a delivery guarantee. A comment is durable the
// moment its INSERT commits (comments.service); this publish just tells any
// currently-connected clients "go refetch". If nobody's subscribed the message
// is dropped, and that's fine: a client that reconnects later re-fetches via
// GET /cases/:id/comments (or /documents/:id/comments) and sees everything
// that happened while it was away. Do NOT put anything here that must not be
// lost — that belongs on mentions.queue.js (BullMQ) instead.
//
// Channel naming: case:{caseId} always; document:{documentId} additionally
// when the comment is document-scoped, so a client viewing just one document
// doesn't have to filter the whole case's firehose.
export async function publishCommentEvent({ type, caseId, documentId, commentId }) {
  const payload = JSON.stringify({ type, caseId, documentId: documentId ?? null, commentId, at: Date.now() });
  const channels = [`case:${caseId}`];
  if (documentId) channels.push(`document:${documentId}`);
  await Promise.all(channels.map((channel) => redis.publish(channel, payload)));
}

export async function publishNotificationEvent(notification) {
  const payload = JSON.stringify({ type: "notification.created", notification, at: Date.now() });
  await redis.publish(`user:${notification.userId}:notifications`, payload);
}
