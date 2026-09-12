import { randomUUID, createHash } from "node:crypto";
import { db } from "../db/index.js";
import { storage, versionStorageKey } from "../storage/index.js";
import { conflict, notFound, forbidden, badRequest } from "../lib/errors.js";
import * as repo from "../repositories/documents.repo.js";
import caseRepository from "../repositories/case.repository.js";
import userRepository from "../repositories/user.repository.js";
import { getActivePolicy } from "../lib/abacPolicy.js";
import { recordAudit, AuditAction, TargetType } from "../audit/index.js";
import { enqueueLedgerAnchor } from "../jobs/ledger.queue.js";
import { enqueueDocumentProcessing } from "../jobs/documentProcessing.queue.js";
import { ledger } from "../ledger/index.js";
import { sha256HexOfStream, decideIntegrity, toCustodyEvents } from "../ledger/integrity.js";

// ── DTO mappers (shapes per DESIGN §13) ───────────────────────────────────────
function toVersionDTO(v) {
  return {
    id: v.id,
    documentId: v.documentId,
    versionNo: v.versionNo,
    fileName: v.fileName,
    mimeType: v.mimeType,
    sizeBytes: Number(v.sizeBytes),
    sha256: v.sha256,
    ledgerTxId: v.ledgerTxId ?? undefined,
    ledgerStatus: v.ledgerStatus,
    anchoredAt: v.anchoredAt ?? undefined,
    signatureCount: 0, // signatures not implemented yet (DESIGN §4)
    uploadedBy: { id: v.createdBy }, // hydrate to UserSummary once users lands
    note: v.note ?? undefined,
    processingStatus: v.processingStatus,
    integrityStatus: v.integrityStatus,
    createdAt: v.createdAt,
  };
}

function toDocumentDTO(doc, currentVer, versionsCount) {
  return {
    id: doc.id,
    caseId: doc.caseId,
    title: doc.title,
    docType: doc.docType,
    classification: doc.classification,
    description: doc.description ?? undefined,
    currentVersionId: doc.currentVersionId,
    currentVersionNo: currentVer?.versionNo ?? null,
    integrityStatus: currentVer?.integrityStatus ?? "PENDING",
    processingStatus: currentVer?.processingStatus ?? "READY",
    ledgerStatus: currentVer?.ledgerStatus ?? "PENDING_LEDGER",
    anchoredAt: currentVer?.anchoredAt ?? null,
    versionsCount,
    tags: doc.tags ?? [],
    sealed: doc.sealed,
    createdBy: { id: doc.createdBy },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toDocumentSummaryDTO(doc, currentVer) {
  return {
    id: doc.id,
    caseId: doc.caseId,
    title: doc.title,
    docType: doc.docType,
    classification: doc.classification,
    currentVersionNo: currentVer?.versionNo ?? null,
    integrityStatus: currentVer?.integrityStatus ?? "PENDING",
    processingStatus: currentVer?.processingStatus ?? "READY",
    updatedAt: doc.updatedAt,
  };
}

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

// ── operations ────────────────────────────────────────────────────────────────

// Upload a file as the first version of a new document.
export async function createDocument({ caseId, userId, ip, file, metadata }) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const storageKey = versionStorageKey({ caseId, documentId, versionId });
  const sha256 = sha256Hex(file.buffer);

  // Store the bytes FIRST, then commit metadata. If the DB write fails we delete
  // the orphaned object, so a committed row always has its bytes behind it.
  await storage.putObject({
    key: storageKey,
    body: file.buffer,
    contentType: file.mimetype,
    metadata: { sha256 },
  });

  let created;
  try {
    created = await db.transaction(async (tx) => {
      await repo.insertDocument(tx, {
        id: documentId,
        caseId,
        title: metadata.title,
        docType: metadata.docType,
        classification: metadata.classification,
        description: metadata.description,
        tags: metadata.tags ?? [],
        createdBy: userId,
      });
      const version = await repo.insertVersion(tx, {
        id: versionId,
        documentId,
        fileName: file.originalname,
        storageKey,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        sha256,
        createdBy: userId,
        // Left at the schema default "SCANNING": the async intelligence pipeline
        // (enqueued after commit below) drives it to READY — or QUARANTINED/FAILED.
        // Enqueued below, after commit — the virus-scan/OCR/NER/auto-tag
        // pipeline (DESIGN §11) drives this SCANNING -> OCR -> INDEXING -> READY.
        processingStatus: "SCANNING",
      });
      // Same transaction: no document exists without its "created" audit entry.
      await recordAudit(tx, {
        actorId: userId,
        action: AuditAction.DOCUMENT_CREATED,
        targetType: TargetType.DOCUMENT,
        targetId: documentId,
        ip,
        details: {
          caseId,
          title: metadata.title,
          docType: metadata.docType,
          classification: metadata.classification,
          versionNo: version.versionNo,
          fileName: version.fileName,
          sha256,
        },
      });
      return version;
    });
  } catch (err) {
    await storage.deleteObject(storageKey).catch(() => {});
    throw err;
  }

  // Anchor the new version's hash on the ledger — AFTER commit, so the worker is
  // guaranteed to find the committed row. Fail-open: a failed enqueue never fails
  // the upload; the row just stays PENDING_LEDGER for later reconciliation.
  await enqueueLedgerAnchor({
    versionId,
    docId: documentId,
    caseId,
    versionNo: created.versionNo,
    sha256,
    classification: metadata.classification,
    storageRef: storageKey,
    actor: userId,
  });

  // Kick off the async intelligence pipeline (ClamAV -> extract/OCR -> NER ->
  // auto-tag -> index). Fail-open, same as the anchor enqueue: a broker hiccup
  // leaves the version SCANNING for the worker's reconciliation sweep.
  // Same fail-open discipline as the ledger anchor enqueue above.
  await enqueueDocumentProcessing({
    versionId,
    documentId,
    caseId,
    actor: userId,
    storageKey,
    mimeType: file.mimetype,
  });

  return getDocument(documentId);
}

// Upload a new immutable version of an existing document.
export async function addVersion({ documentId, userId, ip, file, metadata }) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  if (doc.sealed) throw conflict("document is sealed; no new versions allowed");

  const versionId = randomUUID();
  const storageKey = versionStorageKey({
    caseId: doc.caseId,
    documentId,
    versionId,
  });
  const sha256 = sha256Hex(file.buffer);

  await storage.putObject({
    key: storageKey,
    body: file.buffer,
    contentType: file.mimetype,
    metadata: { sha256 },
  });

  let version;
  try {
    version = await db.transaction(async (tx) => {
      const inserted = await repo.insertVersion(tx, {
        id: versionId,
        documentId,
        fileName: file.originalname,
        storageKey,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        sha256,
        note: metadata.note,
        createdBy: userId,
        // Schema default "SCANNING"; the async pipeline (enqueued after commit) advances it.
        processingStatus: "SCANNING",
      });
      await recordAudit(tx, {
        actorId: userId,
        action: AuditAction.VERSION_ADDED,
        targetType: TargetType.VERSION,
        targetId: versionId,
        ip,
        details: {
          documentId,
          versionNo: inserted.versionNo,
          fileName: inserted.fileName,
          sha256,
          note: metadata.note ?? null,
        },
      });
      return inserted;
    });
  } catch (err) {
    await storage.deleteObject(storageKey).catch(() => {});
    throw err;
  }

  // Anchor after commit (fail-open) — see createDocument.
  await enqueueLedgerAnchor({
    versionId,
    docId: documentId,
    caseId: doc.caseId,
    versionNo: version.versionNo,
    sha256,
    classification: doc.classification,
    storageRef: storageKey,
    actor: userId,
  });

  // Async intelligence pipeline for the new version (fail-open) — see createDocument.
  await enqueueDocumentProcessing({
    versionId,
    documentId,
    caseId: doc.caseId,
    actor: userId,
    storageKey,
    mimeType: file.mimetype,
  });

  return toVersionDTO(version);
}

export async function getDocument(id) {
  const doc = await repo.getDocumentById(id);
  if (!doc) throw notFound("document not found");
  const currentVer = doc.currentVersionId
    ? await repo.getVersionById(doc.currentVersionId)
    : null;
  const versionsCount = await repo.countVersions(id);
  return toDocumentDTO(doc, currentVer, versionsCount);
}

export async function listDocuments(caseId, pagination) {
  const { rows, total } = await repo.listDocumentsByCase(caseId, pagination);
  return {
    items: rows.map(({ doc, ver }) => toDocumentSummaryDTO(doc, ver)),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

export async function listVersions(documentId) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const versions = await repo.listVersions(documentId);
  return { items: versions.map(toVersionDTO) };
}

// Presigned, time-limited download URL for one version — the { url, expiresAt }
// of DESIGN §13.4.
export async function getDownloadUrl(documentId, versionId, { watermark, userId, ip } = {}) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const version = await repo.getVersion(documentId, versionId);
  if (!version) throw notFound("version not found");

  // Access event: record who was granted the ability to fetch the bytes. The
  // object fetch itself happens directly against storage via the presigned URL,
  // so this logs issuance, not the byte transfer. Fail-closed — no URL is
  // returned unless the audit entry commits.
  await db.transaction((tx) =>
    recordAudit(tx, {
      actorId: userId,
      action: AuditAction.VERSION_DOWNLOADED,
      targetType: TargetType.VERSION,
      targetId: versionId,
      ip,
      details: {
        documentId,
        versionNo: version.versionNo,
        fileName: version.fileName,
        watermark: !!watermark,
      },
    }),
  );

  // TODO(watermark): DESIGN §12 wants a viewer-name/timestamp watermark on
  // download. Accepted but not yet applied; returns the raw presigned URL.
  return storage.getSignedDownloadUrl(version.storageKey, {
    fileName: version.fileName,
    contentType: version.mimeType,
  });
}

// A single version's metadata (§4: GET /documents/:id/versions/:vid).
export async function getVersion(documentId, versionId) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const version = await repo.getVersion(documentId, versionId);
  if (!version) throw notFound("version not found");
  return toVersionDTO(version);
}

// Document-intelligence results for one version: ClamAV verdict, extracted text,
// entities and tags produced by the async pipeline
// (src/jobs/documentProcessing.processor.js). GET /documents/:id/versions/:vid/extraction.
export async function getVersionExtraction(documentId, versionId, { includeText = false } = {}) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const version = await repo.getVersion(documentId, versionId);
  if (!version) throw notFound("version not found");

  const extraction = await repo.getExtractionByVersion(versionId);
  if (!extraction) {
    // Enqueued but not started, or processing disabled.
    return {
      versionId,
      processingStatus: version.processingStatus,
      status: version.processingStatus,
      method: null,
      scannedClean: false,
      entities: [],
      tags: [],
    };
  }

  const entities = await repo.listEntitiesByVersion(versionId);
  return {
    versionId,
    processingStatus: version.processingStatus,
    status: extraction.status,
    method: extraction.extractionMethod,
    mimeType: extraction.mimeType,
    textChars: extraction.textChars,
    pageCount: extraction.pageCount ?? null,
    ocrConfidence: extraction.ocrConfidence == null ? null : Number(extraction.ocrConfidence),
    scannedClean: extraction.scannedClean,
    virusSignature: extraction.virusSignature ?? undefined,
    error: extraction.error ?? undefined,
    startedAt: extraction.startedAt ?? undefined,
    finishedAt: extraction.finishedAt ?? undefined,
    tags: Array.isArray(extraction.tags) ? extraction.tags : [],
    entities: entities.map((e) => ({
      type: e.type,
      value: e.value,
      normalizedValue: e.normalizedValue ?? undefined,
      confidence: e.confidence == null ? undefined : Number(e.confidence),
      startOffset: e.startOffset ?? undefined,
      endOffset: e.endOffset ?? undefined,
      source: e.source,
    })),
    // Extracted text is potentially large and is untrusted OCR output — only
    // returned when explicitly asked for (?includeText=true).
    ...(includeText ? { text: extraction.extractedText ?? "" } : {}),
  };
}

// Restore an older version by creating a NEW version whose bytes are copied from
// the source (§4: POST /documents/:id/versions/:vid/restore). The version_no
// trigger bumps the number and the current-pointer trigger moves
// current_version_id to the new row, so the restored content becomes current.
// Returns the updated Document.
export async function restoreVersion({ documentId, sourceVersionId, userId, ip }) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  if (doc.sealed) throw conflict("document is sealed; no new versions allowed");
  const source = await repo.getVersion(documentId, sourceVersionId);
  if (!source) throw notFound("version not found");

  const newVersionId = randomUUID();
  const storageKey = versionStorageKey({
    caseId: doc.caseId,
    documentId,
    versionId: newVersionId,
  });

  // Content is byte-identical to the source, so we reuse its sha256 rather than
  // re-hashing. Copy the object FIRST, then commit metadata — same
  // store-then-commit / compensating-delete discipline as create & addVersion.
  await storage.copyObject({
    sourceKey: source.storageKey,
    destKey: storageKey,
    contentType: source.mimeType,
    metadata: { sha256: source.sha256 },
  });

  let restored;
  try {
    restored = await db.transaction(async (tx) => {
      const inserted = await repo.insertVersion(tx, {
        id: newVersionId,
        documentId,
        fileName: source.fileName,
        storageKey,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        note: `Restored from version ${source.versionNo}`,
        restoredFromVersionId: source.id,
        createdBy: userId,
        // Schema default "SCANNING"; the async pipeline (enqueued after commit)
        // re-scans and re-extracts the restored bytes like any other version.
      });
      await recordAudit(tx, {
        actorId: userId,
        action: AuditAction.VERSION_RESTORED,
        targetType: TargetType.VERSION,
        targetId: newVersionId,
        ip,
        details: {
          documentId,
          versionNo: inserted.versionNo,
          restoredFromVersionId: source.id,
          restoredFromVersionNo: source.versionNo,
          sha256: source.sha256,
          fileName: source.fileName,
        },
      });
      return inserted;
    });
  } catch (err) {
    await storage.deleteObject(storageKey).catch(() => {});
    throw err;
  }

  // Anchor after commit (fail-open) — see createDocument. Restored content is
  // byte-identical to the source, so we anchor the source's sha256.
  await enqueueLedgerAnchor({
    versionId: newVersionId,
    docId: documentId,
    caseId: doc.caseId,
    versionNo: restored.versionNo,
    sha256: source.sha256,
    classification: doc.classification,
    storageRef: storageKey,
    actor: userId,
  });

  // Async intelligence pipeline for the restored version (fail-open) — see createDocument.
  await enqueueDocumentProcessing({
    versionId: newVersionId,
    documentId,
    caseId: doc.caseId,
    actor: userId,
    storageKey,
    mimeType: source.mimeType,
  });

  return getDocument(documentId);
}

// ── integrity, custody, seal (ledger read/seal surface, DESIGN §4) ─────────────

// Verify a document's current version by re-hashing the bytes actually in storage
// and comparing against BOTH the mirror's recorded sha256 and the hash anchored on
// the ledger. This ALWAYS reads the object (authoritative tamper detection, not a
// metadata lookup — user decision), so it also catches storage-side corruption the
// DB/ledger can't see. The verdict is persisted to the version's whitelisted-
// mutable integrity_status / integrity_checked_at and written to the audit chain in
// one transaction, mirroring the anchor worker (ledger read outside, DB+audit in).
export async function verifyIntegrity(documentId, { userId, ip } = {}) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const version = doc.currentVersionId
    ? await repo.getVersionById(doc.currentVersionId)
    : null;
  if (!version) throw notFound("document has no current version to verify");

  // Re-hash the object as it exists right now (streamed — evidence can be large).
  const { body } = await storage.getObject(version.storageKey);
  const recomputed = await sha256HexOfStream(body);

  // Cross-check against the on-chain anchor. verifyHash yields the anchored record
  // (or null when the version was never anchored); record.sha256 is the anchored
  // hash — distinct from the mirror's version.sha256.
  const { record } = await ledger.verifyHash(version.id, recomputed);
  const ledgerHash = record?.sha256 ?? null;
  const anchored = version.ledgerStatus === "ANCHORED";

  const { status, matches } = decideIntegrity({
    recomputed,
    dbSha256: version.sha256,
    ledgerHash,
    anchored,
  });

  const checkedAt = new Date();
  await db.transaction(async (tx) => {
    await repo.setIntegrityChecked(tx, {
      versionId: version.id,
      integrityStatus: status,
      integrityCheckedAt: checkedAt,
    });
    await recordAudit(tx, {
      actorId: userId,
      action: AuditAction.VERSION_VERIFIED,
      targetType: TargetType.VERSION,
      targetId: version.id,
      ip,
      details: {
        documentId,
        versionNo: version.versionNo,
        status,
        matches,
        recomputed,
        dbSha256: version.sha256,
        ledgerHash,
        anchored,
      },
    });
  });

  // Contract shape (DESIGN §4). `sha256` is the live recomputed hash so a TAMPERED
  // result surfaces the drift; signatures stay [] until PKI lands.
  return {
    status,
    sha256: recomputed,
    ledgerTxId: version.ledgerTxId ?? null,
    ledgerHash,
    matches,
    signatures: [],
    lastCheckedAt: checkedAt.toISOString(),
  };
}

// Full chain-of-custody trail for a document: every ledger event across ALL its
// versions, merged and ordered oldest-first (DESIGN §4: GET /documents/:id/custody).
// Pure read — no mutation, no audit entry.
export async function getCustody(documentId) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const versions = await repo.listVersions(documentId);
  const perVersion = await Promise.all(
    versions.map(async (v) => ({
      versionNo: v.versionNo,
      entries: await ledger.getDocumentHistory(v.id),
    })),
  );
  return { events: toCustodyEvents(perVersion) };
}

// Seal a document: freeze it on the ledger and in the mirror so no further versions
// can be added (DESIGN §4: POST /documents/:id/seal). Sensitive — the route gates
// it behind real auth + MFA step-up. The ledger keys on versionId, so we seal the
// current version; the on-chain seal (submitted BEFORE the DB write, same discipline
// as the anchor worker) is the source of truth. Returns the updated Document.
export async function sealDocument({ documentId, userId, ip, reason } = {}) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  if (doc.sealed) throw conflict("document is already sealed");
  if (!doc.currentVersionId) {
    throw conflict("document has no current version to seal");
  }
  const version = await repo.getVersionById(doc.currentVersionId);
  // The ledger can only seal a version it has anchored; sealing an unanchored one
  // would throw an opaque "version … not found" at the seam. Require ANCHORED so
  // the caller gets a clean 409 instead.
  if (!version || version.ledgerStatus !== "ANCHORED") {
    throw conflict("current version is not yet anchored on the ledger");
  }

  // Seal on the ledger OUTSIDE the DB transaction. Treat an already-sealed record
  // as idempotent success so a retry after a partial failure still reconciles the
  // mirror (re-read to recover the txId/actorOrg).
  let result;
  try {
    result = await ledger.sealDocument(doc.currentVersionId, userId);
  } catch (err) {
    if (!/already SEALED/i.test(String(err?.message ?? err))) throw err;
    result = {
      txId: version.ledgerTxId,
      record: await ledger.getVersion(doc.currentVersionId),
    };
  }

  await db.transaction(async (tx) => {
    await repo.setDocumentSealed(tx, { documentId });
    await recordAudit(tx, {
      actorId: userId,
      action: AuditAction.DOCUMENT_SEALED,
      targetType: TargetType.DOCUMENT,
      targetId: documentId,
      ip,
      details: {
        versionId: doc.currentVersionId,
        versionNo: version.versionNo,
        ledgerTxId: result?.txId ?? null,
        actorOrg: result?.record?.actorOrg ?? null,
        reason: reason ?? null,
      },
    });
  });

  return getDocument(documentId);
}

// ── access grants (POST /documents/:id/access) ─────────────────────────────
// Read-only, whole-document, time-bound, per-user. See authorize.js#canAccessCase
// for how a grant is consumed (it's the only thing that can cross jurisdiction)
// and the design discussion in this conversation for why the rules below are
// shaped this way.
const ORG_TIER_ROLES = new Set(["ORG_ADMIN", "SYSTEM_ADMIN"]);

function toAccessGrantDTO(row) {
  return {
    id: row.id,
    documentId: row.documentId,
    grantee: { id: row.granteeUserId },
    grantedBy: { id: row.grantedBy },
    crossJurisdiction: row.crossJurisdiction,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Same relation canAccessCase trusts for in-jurisdiction access: elevated role,
// case creator, or assigned officer. Computed directly (not via authorize())
// because authorize()'s resource check is jurisdiction-first and would reject
// the cross-jurisdiction branch in grantAccess below before ever reaching it.
async function hasStandingCaseAccess(actor, caseRow, policy) {
  if (policy.elevatedCaseRoles.includes(actor.role)) return true;
  if (caseRow.createdBy === actor.id) return true;
  const officers = await caseRepository.listOfficers(caseRow.id);
  return officers.some((o) => o.userId === actor.id);
}

export async function grantAccess({ documentId, actor, granteeUserId, expiresAt, ip }) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  if (doc.sealed) throw conflict("document is sealed; access grants are frozen");

  const caseRow = await caseRepository.findById(doc.caseId);
  if (!caseRow) throw notFound("case not found");

  if (granteeUserId === actor.id) throw badRequest("cannot grant access to yourself");
  const grantee = await userRepository.findById(granteeUserId);
  if (!grantee || grantee.status !== "ACTIVE") throw badRequest("grantee is not an active user");

  const policy = await getActivePolicy();
  const clearanceRank = policy.clearanceRank;
  if ((clearanceRank[grantee.clearance] ?? -1) < (clearanceRank[caseRow.classification] ?? Infinity)) {
    // A grant gives reach, not a clearance override — this stays a hard floor.
    throw badRequest("grantee's clearance is below the case's classification");
  }

  const crossJurisdiction = grantee.jurisdictionId !== caseRow.jurisdictionId;

  if (crossJurisdiction) {
    // Crossing jurisdiction is a privileged, org-tier call — the actor doesn't
    // need standing access to THIS case to make it (that's the point: they're
    // the trusted authority for the boundary being crossed, not a case-team
    // member extending their own visibility).
    if (!ORG_TIER_ROLES.has(actor.role)) {
      throw forbidden("cross-jurisdiction access grants require an organization administrator");
    }
  } else if (!(await hasStandingCaseAccess(actor, caseRow, policy))) {
    throw forbidden("only an elevated role, the case creator, or an assigned officer can share this document");
  }

  const row = await db.transaction(async (tx) => {
    const grant = await repo.upsertAccessGrant(tx, {
      documentId,
      granteeUserId,
      grantedBy: actor.id,
      expiresAt,
      crossJurisdiction,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: AuditAction.DOCUMENT_ACCESS_GRANTED,
      targetType: TargetType.DOCUMENT,
      targetId: documentId,
      ip,
      details: { granteeUserId, expiresAt, crossJurisdiction },
    });
    return grant;
  });

  return toAccessGrantDTO(row);
}

export async function revokeAccess({ documentId, actor, granteeUserId, ip }) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");

  const existing = await repo.findAccessGrant(documentId, granteeUserId);
  if (!existing || existing.revokedAt) throw notFound("no active grant for this user on this document");

  // Same authority that could have created this grant can revoke it (plus the
  // original granter, in case a role changed since — revocation should never
  // be harder to invoke than the grant it's undoing).
  if (existing.crossJurisdiction) {
    if (!ORG_TIER_ROLES.has(actor.role) && actor.id !== existing.grantedBy) {
      throw forbidden("cross-jurisdiction access grants can only be revoked by an organization administrator");
    }
  } else if (actor.id !== existing.grantedBy) {
    const caseRow = await caseRepository.findById(doc.caseId);
    const policy = await getActivePolicy();
    if (!caseRow || !(await hasStandingCaseAccess(actor, caseRow, policy))) {
      throw forbidden("only an elevated role, the case creator, or an assigned officer can revoke this grant");
    }
  }

  await db.transaction(async (tx) => {
    await repo.revokeAccessGrant(tx, { documentId, granteeUserId });
    await recordAudit(tx, {
      actorId: actor.id,
      action: AuditAction.DOCUMENT_ACCESS_REVOKED,
      targetType: TargetType.DOCUMENT,
      targetId: documentId,
      ip,
      details: { granteeUserId, crossJurisdiction: existing.crossJurisdiction },
    });
  });
}

export async function listAccessGrants(documentId) {
  const doc = await repo.getDocumentById(documentId);
  if (!doc) throw notFound("document not found");
  const rows = await repo.listAccessGrants(documentId);
  return rows.map(toAccessGrantDTO);
}