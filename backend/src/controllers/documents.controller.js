import { badRequest } from "../lib/errors.js";
import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import {
  createDocumentMetadataSchema,
  newVersionMetadataSchema,
  paginationSchema,
  sealSchema,
  grantAccessSchema,
} from "../validation/documents.schema.js";
import * as service from "../services/documents.service.js";

// The multipart "metadata" field carries a JSON blob; fall back to plain form
// fields if a client sent them directly.
function readMetadata(req) {
  const raw = req.body?.metadata;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      return JSON.parse(raw);
    } catch {
      throw badRequest("metadata must be valid JSON");
    }
  }
  return req.body ?? {};
}

function requireFile(req) {
  if (!req.file) throw badRequest("a file is required (multipart field 'file')");
  return req.file;
}

export async function createDocument(req, res) {
  const { caseId } = req.params;
  await authorize({ user: req.user, action: "document:create", resource: { caseId } });
  const file = requireFile(req);
  const metadata = parse(createDocumentMetadataSchema, readMetadata(req));
  const doc = await service.createDocument({
    caseId,
    userId: req.user.id,
    ip: req.ip,
    file,
    metadata,
  });
  res.status(202).json(doc);
}

export async function addVersion(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:add-version", resource: { documentId: id } });
  const file = requireFile(req);
  const metadata = parse(newVersionMetadataSchema, readMetadata(req));
  const version = await service.addVersion({
    documentId: id,
    userId: req.user.id,
    ip: req.ip,
    file,
    metadata,
  });
  res.status(202).json(version);
}

export async function getDocument(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:read", resource: { documentId: id } });
  res.json(await service.getDocument(id));
}

export async function listDocuments(req, res) {
  const { caseId } = req.params;
  await authorize({ user: req.user, action: "document:list", resource: { caseId } });
  const pagination = parse(paginationSchema, req.query);
  res.json(await service.listDocuments(caseId, pagination));
}

export async function listVersions(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:read", resource: { documentId: id } });
  res.json(await service.listVersions(id));
}

export async function download(req, res) {
  const { id, vid } = req.params;
  await authorize({
    user: req.user,
    action: "document:download",
    resource: { documentId: id, versionId: vid },
  });
  const result = await service.getDownloadUrl(id, vid, {
    watermark: req.query.watermark === "true",
    userId: req.user.id,
    ip: req.ip,
  });
  res.json(result);
}

export async function getVersion(req, res) {
  const { id, vid } = req.params;
  await authorize({
    user: req.user,
    action: "document:read",
    resource: { documentId: id, versionId: vid },
  });
  res.json(await service.getVersion(id, vid));
}

export async function getVersionExtraction(req, res) {
  const { id, vid } = req.params;
  await authorize({
    user: req.user,
    action: "document:read",
    resource: { documentId: id, versionId: vid },
  });
  const includeText = req.query.includeText === "true" || req.query.includeText === "1";
  res.json(await service.getVersionExtraction(id, vid, { includeText }));
}

export async function restoreVersion(req, res) {
  const { id, vid } = req.params;
  await authorize({
    user: req.user,
    action: "document:restore",
    resource: { documentId: id, versionId: vid },
  });
  const doc = await service.restoreVersion({
    documentId: id,
    sourceVersionId: vid,
    userId: req.user.id,
    ip: req.ip,
  });
  res.json(doc);
}

// Re-hash the current version's bytes and report the integrity verdict (DESIGN §4).
export async function getIntegrity(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:read", resource: { documentId: id } });
  res.json(await service.verifyIntegrity(id, { userId: req.user.id, ip: req.ip }));
}

// The document's full chain-of-custody trail from the ledger (DESIGN §4).
export async function getCustody(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:read", resource: { documentId: id } });
  res.json(await service.getCustody(id));
}

// Seal a document. The route gates this behind requireAuth + requireStepUp, so
// req.user is the real authenticated caller (not the dev shim) whose step-up token
// was verified for the same subject.
export async function sealDocument(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:seal", resource: { documentId: id } });
  const { reason } = parse(sealSchema, req.body ?? {});
  const doc = await service.sealDocument({
    documentId: id,
    userId: req.user.id,
    ip: req.ip,
    reason,
  });
  res.json(doc);
}

// Grant/renew a read-only, time-bound, per-user access to this document. Only
// an RBAC gate here (no resource check) — grantAccess itself decides who's
// allowed, since that decision differs for same- vs cross-jurisdiction grants
// in a way canAccessCase's generic jurisdiction-first check can't express.
export async function grantDocumentAccess(req, res) {
  const { id } = req.params;
  await authorize({ user: req.user, action: "document:share", resource: {} });
  const { granteeUserId, expiresAt } = parse(grantAccessSchema, req.body ?? {});
  const grant = await service.grantAccess({
    documentId: id,
    actor: req.user,
    granteeUserId,
    expiresAt,
    ip: req.ip,
  });
  res.status(201).json(grant);
}

export async function revokeDocumentAccess(req, res) {
  const { id, userId } = req.params;
  await authorize({ user: req.user, action: "document:share", resource: {} });
  await service.revokeAccess({ documentId: id, actor: req.user, granteeUserId: userId, ip: req.ip });
  res.status(204).end();
}

export async function listDocumentAccess(req, res) {
  const { id } = req.params;
  // Same visibility as the document itself: whoever can read it can see who
  // else currently has access to it.
  await authorize({ user: req.user, action: "document:read", resource: { documentId: id } });
  res.json(await service.listAccessGrants(id));
}
