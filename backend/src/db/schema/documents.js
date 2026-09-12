import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  char,
  unique,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {  docType, integrityStatus, processingStatus, classification, ledgerStatus } from "./enums.js";

// ─────────────────────────────────────────────────────────────────────────────
// documents: one row per logical document (an FIR, a chargesheet, ...).
// Points at its current version; the full history lives in document_versions.
//
// FKs to teammate-owned tables (case_id -> cases, created_by -> users) and the
// circular current_version_id -> document_versions FK are added in the
// `external_fks` / `version_control` custom migrations, not here.
// ─────────────────────────────────────────────────────────────────────────────
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    title: text("title").notNull(),
    docType: docType("doc_type").notNull(),
    classification: classification("classification").notNull(),
    description: text("description"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Auto-maintained by an AFTER INSERT trigger on document_versions.
    // Nullable: a freshly created document has no version until its first upload.
    currentVersionId: uuid("current_version_id"),
    sealed: boolean("sealed").notNull().default(false),
    // Soft delete only — versions are evidence and are never hard-deleted, so a
    // document is retired by stamping deleted_at rather than removing rows.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_case_id_idx").on(t.caseId),
    index("documents_doc_type_idx").on(t.docType),
    index("documents_classification_idx").on(t.classification),
    index("documents_created_by_idx").on(t.createdBy),
    // Most list queries only care about live documents.
    index("documents_active_idx")
      .on(t.caseId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// document_versions: the heart of version control. IMMUTABLE + APPEND-ONLY
// (enforced by triggers in the `version_control` custom migration). Every edit
// or restore INSERTs a new row; rows are never overwritten or deleted.
//
// File bytes live in encrypted object storage; this row holds only the pointer
// (storage_key), the content fingerprint (sha256), and provenance.
// ─────────────────────────────────────────────────────────────────────────────
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    // Auto-assigned per document by a BEFORE INSERT trigger; the unique
    // constraint below is the backstop against races / manual numbering.
    versionNo: integer("version_no").notNull(),

    // ── content pointer & fingerprint (immutable) ──
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),

    note: text("note"),
    // Lineage: set when this version was produced by restoring an older one.
    restoredFromVersionId: uuid("restored_from_version_id"),

    // ── async / security pipeline columns (the ONLY mutable columns) ──
    processingStatus: processingStatus("processing_status").notNull().default("SCANNING"),
    integrityStatus: integrityStatus("integrity_status").notNull().default("PENDING"),
    ledgerTxId: text("ledger_tx_id"),
    integrityCheckedAt: timestamp("integrity_checked_at", { withTimezone: true }),
    // Blockchain anchoring state machine. Inserted PENDING_LEDGER; the async
    // ledger worker sets ledger_tx_id + anchored_at and flips this to ANCHORED,
    // or to FAILED after exhausting retries. ledger_tx_id above is the on-chain
    // handle once anchored.
    ledgerStatus: ledgerStatus("ledger_status").notNull().default("PENDING_LEDGER"),
    anchoredAt: timestamp("anchored_at", { withTimezone: true }),

    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("document_versions_document_id_version_no_key").on(t.documentId, t.versionNo),
    foreignKey({
      columns: [t.restoredFromVersionId],
      foreignColumns: [t.id],
      name: "document_versions_restored_from_fkey",
    }),
    check("document_versions_size_bytes_check", sql`${t.sizeBytes} >= 0`),
    check("document_versions_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    index("document_versions_document_id_idx").on(t.documentId, t.versionNo),
    index("document_versions_created_by_idx").on(t.createdBy),
    // Lets the async worker pool find versions still being processed.
    index("document_versions_pending_idx")
      .on(t.processingStatus)
      .where(sql`${t.processingStatus} <> 'READY' and ${t.processingStatus} <> 'FAILED'`),
    // Lets a future reconciliation sweeper find versions not yet anchored
    // (PENDING_LEDGER or FAILED) without scanning already-anchored rows.
    index("document_versions_ledger_pending_idx")
      .on(t.ledgerStatus)
      .where(sql`${t.ledgerStatus} <> 'ANCHORED'`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// document_access_grants: explicit, per-user, read-only, time-bound access to
// ONE document. This is the only mechanism that can cross the jurisdiction gate
// in authorize.js#canAccessCase (in-jurisdiction case-team access is unaffected
// by this table — it never needs a grant). Same-jurisdiction grants are just a
// convenience "share with one more person" path.
//
// granteeUserId / grantedBy point at users (teammate-owned) — plain uuid, no
// .references(), matching documents.case_id / documents.created_by above (FK
// added via the external_fks custom migration, not here).
//
// Re-granting (same document + grantee) upserts this row rather than inserting
// a duplicate — see the unique index below — so "update the expiry" and
// "revoke, then share again later" are both just another POST.
export const documentAccessGrants = pgTable(
  "document_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    granteeUserId: uuid("grantee_user_id").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    // Stamped at grant time so audit/reporting doesn't need to re-derive it by
    // joining back through cases/users later (jurisdictions can't be reassigned
    // after the fact anyway, so this is stable history, not a cache to invalidate).
    crossJurisdiction: boolean("cross_jurisdiction").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("document_access_grants_document_grantee_key").on(t.documentId, t.granteeUserId),
    index("document_access_grants_grantee_idx").on(t.granteeUserId),
    // Lets canAccessCase's grant check hit a narrow index instead of scanning
    // every grant for the document.
    index("document_access_grants_active_idx")
      .on(t.documentId, t.granteeUserId)
      .where(sql`${t.revokedAt} is null`),
  ],
);
