import { db } from "../db/index.js";
import { notFound, forbidden } from "../lib/errors.js";
import { authorize } from "../lib/authorize.js";
import commentsRepository from "../repositories/comments.repository.js";
import userRepository from "../repositories/user.repository.js";
import { getDocumentById } from "../repositories/documents.repo.js";
import { recordCaseActivity, CaseActivityAction, ActivityTargetType } from "../activity/index.js";
import { enqueueMentionNotifications } from "../jobs/mentions.queue.js";
import { publishCommentEvent } from "../realtime/publisher.js";

// ── DTO mapper ─────────────────────────────────────────────────────────────
function toCommentDTO(row) {
  return {
    id: row.id,
    caseId: row.caseId,
    documentId: row.documentId ?? null,
    parentCommentId: row.parentCommentId ?? null,
    author: { id: row.authorId },
    body: row.body,
    mentions: row.mentions ?? [],
    editedAt: row.editedAt ?? undefined,
    createdAt: row.createdAt,
  };
}

// Resolve @username tokens to user ids, keeping only users who can actually
// read this case/document — never trust the client to supply mention ids
// directly, and never let a comment reveal a valid mention target the mentioner
// couldn't otherwise see (see design discussion: mentions must piggyback on the
// same PDP as everything else, not bypass it).
async function resolveMentions(body, { caseId, documentId }) {
  let handles = [...new Set([...body.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((m) => m[1]))];


  const resolved = await Promise.all(
    handles.map(async (handle) => {
      const candidate = await userRepository.findByUsername(handle);
      if (!candidate) return null;
      try {
        await authorize({
          user: { id: candidate.id },
          action: "document:read",
          resource: documentId ? { documentId } : { caseId },
        });
        return candidate.id;
      } catch {
        return null; // no access to this thread -> silently not mentionable
      }
    }),
  );

  return resolved.filter(Boolean);
}

export async function createComment({ caseId, documentId, userId, ip, input }) {
  // caseId is NEVER trusted from the client on the document route — always
  // resolved server-side from the document row, same as authorize.js#resolveCase
  // does internally for the PDP check.
  if (documentId) {
    const document = await getDocumentById(documentId);
    if (!document) throw notFound("document not found");
    caseId = document.caseId;
  }

  await authorize({
    user: { id: userId },
    action: documentId ? "document:read" : "case:read",
    resource: documentId ? { documentId } : { caseId },
  });

  if (input.parentCommentId) {
    const parent = await commentsRepository.findById(input.parentCommentId);
    if (!parent || parent.caseId !== caseId || parent.deletedAt) {
      throw notFound("parent comment not found");
    }
  }

  const mentions = await resolveMentions(input.body, { caseId, documentId });

  const comment = await db.transaction(async (tx) => {
    const row = await commentsRepository.create(
      {
        caseId,
        documentId: documentId ?? null,
        parentCommentId: input.parentCommentId ?? null,
        authorId: userId,
        body: input.body,
        mentions,
      },
      tx,
    );

    await recordCaseActivity(tx, {
      caseId,
      actorId: userId,
      action: CaseActivityAction.COMMENT_CREATED,
      targetType: ActivityTargetType.COMMENT,
      targetId: row.id,
      details: { documentId: documentId ?? null, mentions },
    });

    return row;
  });

  // Fire-open, post-commit: never let broker hiccups fail the comment itself
  // (same posture as enqueueLedgerAnchor).

  if (mentions.length > 0) {
    await enqueueMentionNotifications({ commentId: comment.id, caseId, mentions, authorId: userId }).catch((error) => {
      console.error(`Could not enqueue mention notifications for comment ${comment.id}:`, error);
    });
  }
  await publishCommentEvent({ type: "created", caseId, documentId: documentId ?? null, commentId: comment.id }).catch(
    () => {},
  );

  return toCommentDTO(comment);
}

export async function listComments({ caseId, documentId, userId }) {
  await authorize({
    user: { id: userId },
    action: documentId ? "document:read" : "case:read",
    resource: documentId ? { documentId } : { caseId },
  });

  const rows = documentId
    ? await commentsRepository.listForDocument(documentId)
    : await commentsRepository.listForCase(caseId, {});
  return rows.map(toCommentDTO);
}

export async function editComment({ commentId, userId, input }) {
  const existing = await commentsRepository.findById(commentId);
  if (!existing || existing.deletedAt) throw notFound("comment not found");
  if (existing.authorId !== userId) throw forbidden("only the author can edit this comment");

  await authorize({
    user: { id: userId },
    action: existing.documentId ? "document:read" : "case:read",
    resource: existing.documentId ? { documentId: existing.documentId } : { caseId: existing.caseId },
  });

  const mentions = await resolveMentions(input.body, {
    caseId: existing.caseId,
    documentId: existing.documentId,
  });

  const comment = await db.transaction(async (tx) => {
    const row = await commentsRepository.update(
      commentId,
      { body: input.body, mentions, editedAt: new Date() },
      tx,
    );

    await recordCaseActivity(tx, {
      caseId: existing.caseId,
      actorId: userId,
      action: CaseActivityAction.COMMENT_EDITED,
      targetType: ActivityTargetType.COMMENT,
      targetId: commentId,
      details: { documentId: existing.documentId ?? null },
    });

    return row;
  });

  await publishCommentEvent({
    type: "edited",
    caseId: existing.caseId,
    documentId: existing.documentId,
    commentId,
  }).catch(() => {});

  return toCommentDTO(comment);
}

export async function deleteComment({ commentId, userId }) {
  const existing = await commentsRepository.findById(commentId);
  if (!existing || existing.deletedAt) throw notFound("comment not found");
  if (existing.authorId !== userId) throw forbidden("only the author can delete this comment");

  await db.transaction(async (tx) => {
    await commentsRepository.softDelete(commentId, tx);
    await recordCaseActivity(tx, {
      caseId: existing.caseId,
      actorId: userId,
      action: CaseActivityAction.COMMENT_DELETED,
      targetType: ActivityTargetType.COMMENT,
      targetId: commentId,
      details: { documentId: existing.documentId ?? null },
    });
  });

  await publishCommentEvent({
    type: "deleted",
    caseId: existing.caseId,
    documentId: existing.documentId,
    commentId,
  }).catch(() => {});
}
