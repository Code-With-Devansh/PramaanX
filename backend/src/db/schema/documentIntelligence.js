import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documents, documentVersions } from "./documents.js";
import { processingStatus } from "./enums.js";

// ─────────────────────────────────────────────────────────────────────────────
// document_extractions: one row per document_version, holding everything the
// async intelligence pipeline (src/jobs/documentProcessing.processor.js)
// produces that isn't a first-class entity — the extracted text, how it was
// obtained, the ClamAV verdict, per-stage status, and tag provenance.
//
// Kept OUT of document_versions on purpose: that table is immutable/append-only
// (drizzle/0002_version_control.sql) and only whitelists a handful of mutable
// columns. The pipeline rewrites this row several times per job, so it lives
// here. version_id is UNIQUE — the processor upserts by it, which is what makes
// a re-run (jobId = versionId) idempotent.
// ─────────────────────────────────────────────────────────────────────────────
export const documentExtractions = pgTable(
  "document_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),

    // Mirrors document_versions.processing_status for this version; duplicated
    // here so a single read of this row tells the whole pipeline story.
    status: processingStatus("status").notNull().default("SCANNING"),

    // How the text was obtained: pdf_native | ocr_paddle | docx | xlsx |
    // plaintext | none. Plain text (not an enum) so a new extractor doesn't
    // need a migration.
    extractionMethod: text("extraction_method"),
    // Real content type as sniffed from the bytes (file-type), which may differ
    // from the client-declared document_versions.mime_type.
    mimeType: text("mime_type"),

    extractedText: text("extracted_text"),
    textChars: integer("text_chars").notNull().default(0),
    pageCount: integer("page_count"),
    // Mean OCR confidence in [0,1] when extraction_method = ocr_paddle.
    ocrConfidence: numeric("ocr_confidence", { precision: 5, scale: 4 }),

    // Tag provenance: [{ tag, confidence, source }]. The plain tag strings are
    // also unioned into documents.tags via repo.appendDocumentTags.
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),

    // ClamAV outcome. scanned_clean stays false until the scan passes; the
    // pipeline refuses to extract anything that isn't clean.
    scannedClean: boolean("scanned_clean").notNull().default(false),
    virusSignature: text("virus_signature"),

    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("document_extractions_version_id_key").on(t.versionId),
    index("document_extractions_document_id_idx").on(t.documentId),
    // Lets a reconciliation sweep find rows still mid-pipeline. Created in
    // drizzle/0004 (not here): the QUARANTINED value 0003 adds can't be used
    // as an enum literal until that migration's transaction commits, and enum
    // -> text isn't IMMUTABLE so it can't be worked around with a cast.
    index("document_extractions_pending_idx")
      .on(t.status)
      .where(sql`${t.status} not in ('READY', 'FAILED', 'QUARANTINED')`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// document_entities: normalized NER output, one row per extracted mention.
// Matches DESIGN §10's `entities (version_id, type, value)` table, widened with
// a normalized form, confidence, character span, and the provider that found it.
//
// `type` is TEXT, not an enum, by design: custom entity types (IPC/BNS section,
// FIR ref, plate, ...) are added by shipping a new NER provider, never a
// migration. The processor deletes every row for a version_id and re-inserts on
// each run, so results always reflect the latest pipeline pass.
// ─────────────────────────────────────────────────────────────────────────────
export const documentEntities = pgTable(
  "document_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),

    // PERSON | ORGANIZATION | LOCATION | DATE | EMAIL | PHONE | MONEY |
    // LEGAL_SECTION | VEHICLE | CASE_REF | URL | ... (open set).
    type: text("type").notNull(),
    value: text("value").notNull(),
    // Canonical form where one exists: E.164 phone, ISO-8601 date, lowercased
    // email. NULL when the raw value is already canonical / not normalizable.
    normalizedValue: text("normalized_value"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("1"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    // Provider id: regex | spacy | llm | ...
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("document_entities_version_id_idx").on(t.versionId),
    index("document_entities_document_id_type_idx").on(t.documentId, t.type),
    index("document_entities_type_value_idx").on(t.type, t.value),
  ],
);
