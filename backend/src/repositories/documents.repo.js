import { and, count, desc, eq, gt, isNull, or, ilike, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  documents,
  documentVersions,
  documentAccessGrants,
  documentExtractions,
  documentEntities,
} from "../db/schema/index.js";

// ── documents ────────────────────────────────────────────────────────────────
export async function insertDocument(tx, values) {
  const [row] = await tx.insert(documents).values(values).returning();
  return row;
}

export async function getDocumentById(id) {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
  return row ?? null;
}

// One page of a case's live documents, each left-joined to its current version
// so the summary can show current version number + processing/integrity status.
export async function listDocumentsByCase(caseId, { page, pageSize }) {
  const where = and(eq(documents.caseId, caseId), isNull(documents.deletedAt));
  const rows = await db
    .select({ doc: documents, ver: documentVersions })
    .from(documents)
    .leftJoin(
      documentVersions,
      eq(documents.currentVersionId, documentVersions.id),
    )
    .where(where)
    .orderBy(desc(documents.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ total }] = await db
    .select({ total: count() })
    .from(documents)
    .where(where);
  return { rows, total: Number(total) };
}

// ── document processing pipeline (documentProcessing.processor.js) ────────────
export async function setProcessingStatus(tx, { versionId, processingStatus }) {
  const [row] = await tx
    .update(documentVersions)
    .set({ processingStatus })
    .where(eq(documentVersions.id, versionId))
    .returning();
  return row;
}


export async function appendDocumentTags(tx, { documentId, tags }) {
  if (!tags?.length) return;
  const [row] = await tx
    .update(documents)
    .set({
      tags: sql`(
        select coalesce(array_agg(distinct t), '{}')
        from unnest(${documents.tags} || ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]) as t
      )`,
      updatedAt: sql`now()`,
    })
    .where(eq(documents.id, documentId))
    .returning();
  return row;
}

// ── document intelligence: extractions + entities ────────────────────────────
// (src/jobs/documentProcessing.processor.js). document_extractions holds one
// row per version; the processor upserts it by version_id (idempotent re-runs).

// Create the row if absent, else touch updated_at. Called once at job start so
// every later setExtractionFields has a row to update.
export async function ensureExtraction(tx, { versionId, documentId, status = "SCANNING" }) {
  const [row] = await tx
    .insert(documentExtractions)
    .values({ versionId, documentId, status, startedAt: sql`now()` })
    .onConflictDoUpdate({
      target: documentExtractions.versionId,
      set: { updatedAt: sql`now()` },
    })
    .returning();
  return row;
}

// Patch an arbitrary subset of the pipeline's mutable columns; always bumps
// updated_at. `fields` keys are drizzle column names (status, extractedText, …).
export async function setExtractionFields(tx, { versionId, fields }) {
  const [row] = await tx
    .update(documentExtractions)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(documentExtractions.versionId, versionId))
    .returning();
  return row ?? null;
}

export async function getExtractionByVersion(versionId) {
  const [row] = await db
    .select()
    .from(documentExtractions)
    .where(eq(documentExtractions.versionId, versionId));
  return row ?? null;
}

// Replace every entity row for a version with a fresh set, in one statement pair,
// so a re-run never leaves stale mentions behind.
export async function replaceEntities(tx, { versionId, documentId, entities }) {
  await tx.delete(documentEntities).where(eq(documentEntities.versionId, versionId));
  if (!entities?.length) return [];
  return tx
    .insert(documentEntities)
    .values(
      entities.map((e) => ({
        versionId,
        documentId,
        type: e.type,
        value: e.value,
        normalizedValue: e.normalizedValue ?? null,
        confidence: String(e.confidence ?? 1),
        startOffset: e.startOffset ?? null,
        endOffset: e.endOffset ?? null,
        source: e.source,
      })),
    )
    .returning();
}

export async function listEntitiesByVersion(versionId) {
  return db
    .select()
    .from(documentEntities)
    .where(eq(documentEntities.versionId, versionId))
    .orderBy(documentEntities.type, documentEntities.startOffset);
}

// Versions stuck mid-pipeline longer than `olderThan` — fuel for the worker's
// reconciliation sweep (mirrors the ledger's pending-anchor sweeper).
export async function listStuckExtractions(olderThan, limit = 100) {
  return db
    .select({
      versionId: documentExtractions.versionId,
      documentId: documentExtractions.documentId,
      status: documentExtractions.status,
    })
    .from(documentExtractions)
    .where(
      and(
        sql`${documentExtractions.status}::text not in ('READY', 'FAILED', 'QUARANTINED')`,
        sql`${documentExtractions.updatedAt} < ${olderThan}`,
      ),
    )
    .limit(limit);
}

// ── document_versions ─────────────────────────────────────────────────────────
export async function insertVersion(tx, values) {
  // version_no is intentionally omitted: a BEFORE INSERT trigger assigns it
  // (MAX+1 per document, race-safe) and an AFTER INSERT trigger points
  // documents.current_version_id at this new row.
  const [row] = await tx.insert(documentVersions).values(values).returning();
  return row;
}

export async function getVersion(documentId, versionId) {
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.id, versionId),
      ),
    );
  return row ?? null;
}

export async function getVersionById(versionId) {
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  return row ?? null;
}

export async function listVersions(documentId) {
  return db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNo));
}

export async function countVersions(documentId) {
  const [row] = await db
    .select({ total: count() })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  return Number(row?.total ?? 0);
}

// ── ledger anchoring state transitions ─────────────────────────────────────────
// Both run inside the anchor worker's transaction (so the row change commits
// atomically with its audit entry). They touch only the mutable ledger columns,
// which the immutability guard trigger permits.

// PENDING_LEDGER -> ANCHORED: stamp the on-chain tx id and anchor time.
export async function setLedgerAnchored(tx, { versionId, ledgerTxId, anchoredAt }) {
  const [row] = await tx
    .update(documentVersions)
    .set({ ledgerStatus: "ANCHORED", ledgerTxId, anchoredAt })
    .where(eq(documentVersions.id, versionId))
    .returning();
  return row ?? null;
}

// PENDING_LEDGER -> FAILED: anchoring abandoned after exhausting retries. Leaves
// ledger_tx_id/anchored_at null so a reconciliation sweep can retry later.
export async function setLedgerFailed(tx, { versionId }) {
  const [row] = await tx
    .update(documentVersions)
    .set({ ledgerStatus: "FAILED" })
    .where(eq(documentVersions.id, versionId))
    .returning();
  return row ?? null;
}

// ── integrity + seal state transitions ─────────────────────────────────────────

// Record the outcome of an integrity re-hash on a version. Touches only the
// mutable pipeline columns (integrity_status, integrity_checked_at) that the
// immutability guard trigger permits. Runs inside the verify request's transaction
// so the row change commits atomically with its audit entry.
export async function setIntegrityChecked(tx, { versionId, integrityStatus, integrityCheckedAt }) {
  const [row] = await tx
    .update(documentVersions)
    .set({ integrityStatus, integrityCheckedAt })
    .where(eq(documentVersions.id, versionId))
    .returning();
  return row ?? null;
}

// Seal a document: flip documents.sealed so addVersion/restore refuse further
// versions. Runs inside the seal request's transaction, after the ledger seal has
// been submitted, alongside the DOCUMENT_SEALED audit entry.
export async function setDocumentSealed(tx, { documentId }) {
  const [row] = await tx
    .update(documents)
    .set({ sealed: true, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning();
  return row ?? null;
}

// ── document access grants ──────────────────────────────────────────────────
// Upsert on (documentId, granteeUserId): a second grant to the same person just
// updates expiresAt (and un-revokes, if it had been revoked) rather than erroring.
export async function upsertAccessGrant(tx, { documentId, granteeUserId, grantedBy, expiresAt, crossJurisdiction }) {
  const [row] = await tx
    .insert(documentAccessGrants)
    .values({ documentId, granteeUserId, grantedBy, expiresAt, crossJurisdiction })
    .onConflictDoUpdate({
      target: [documentAccessGrants.documentId, documentAccessGrants.granteeUserId],
      set: { grantedBy, expiresAt, crossJurisdiction, revokedAt: null, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function findAccessGrant(documentId, granteeUserId, tx = db) {
  const [row] = await tx
    .select()
    .from(documentAccessGrants)
    .where(and(eq(documentAccessGrants.documentId, documentId), eq(documentAccessGrants.granteeUserId, granteeUserId)))
    .limit(1);
  return row ?? null;
}

// The actual PDP check (authorize.js): does this user have a live grant — not
// revoked, not expired — for this document? Narrow enough to hit
// document_access_grants_active_idx plus a single expiresAt compare.
export async function hasActiveAccessGrant(documentId, granteeUserId) {
  const [row] = await db
    .select({ id: documentAccessGrants.id })
    .from(documentAccessGrants)
    .where(
      and(
        eq(documentAccessGrants.documentId, documentId),
        eq(documentAccessGrants.granteeUserId, granteeUserId),
        isNull(documentAccessGrants.revokedAt),
        gt(documentAccessGrants.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function revokeAccessGrant(tx, { documentId, granteeUserId }) {
  const [row] = await tx
    .update(documentAccessGrants)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(documentAccessGrants.documentId, documentId),
        eq(documentAccessGrants.granteeUserId, granteeUserId),
        isNull(documentAccessGrants.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listAccessGrants(documentId) {
  return db
    .select()
    .from(documentAccessGrants)
    .where(and(eq(documentAccessGrants.documentId, documentId), isNull(documentAccessGrants.revokedAt)))
    .orderBy(desc(documentAccessGrants.createdAt));
}