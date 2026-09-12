import { parse } from "../lib/validate.js";
import { createCommentSchema, editCommentSchema } from "../validation/comments.schema.js";
import * as service from "../services/comments.service.js";

export async function createCaseComment(req, res) {
  const { caseId } = req.params;
  const input = parse(createCommentSchema, req.body);
  const comment = await service.createComment({ caseId, userId: req.user.id, ip: req.ip, input });
  res.status(201).json(comment);
}

export async function listCaseComments(req, res) {
  const { caseId } = req.params;
  const comments = await service.listComments({ caseId, userId: req.user.id });
  res.json({ items: comments });
}

export async function createDocumentComment(req, res) {
  const { id: documentId } = req.params;
  const input = parse(createCommentSchema, req.body);
  const comment = await service.createComment({ documentId, userId: req.user.id, ip: req.ip, input });
  res.status(201).json(comment);
}

export async function listDocumentComments(req, res) {
  const { id: documentId } = req.params;
  const comments = await service.listComments({ documentId, userId: req.user.id });
  res.json({ items: comments });
}

export async function editComment(req, res) {
  const { commentId } = req.params;
  const input = parse(editCommentSchema, req.body);
  const comment = await service.editComment({ commentId, userId: req.user.id, input });
  res.json(comment);
}

export async function deleteComment(req, res) {
  const { commentId } = req.params;
  await service.deleteComment({ commentId, userId: req.user.id });
  res.status(204).end();
}
