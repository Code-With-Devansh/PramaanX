import { opensearch } from "./opensearch.client.js";

// One doc per (documentId), keyed by documentId (not versionId) — we only ever
// index the CURRENT version (see search.service.js#indexDocument). Re-indexing
// on every new version just overwrites the same _id.
export const DOCUMENTS_INDEX = "pramaanx-documents";

// Fields kept here are deliberately NOT the full authorization model — see the
// big comment in search.service.js#searchDocuments for why access control is
// re-checked against Postgres per result rather than baked into the index.
// caseId/classification/docType/tags are here as SEARCH FILTERS (facets the
// caller explicitly asked to narrow by), not as an access boundary.
const MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 1,
    analysis: {
      analyzer: {
        // Default analyzer is fine for English OCR/case text; english_exact
        // (no stemming) backs .exact subfields for phrase-ish precision matches
        // on titles/tags where stemming hurts more than it helps.
        english_exact: {
          type: "custom",
          tokenizer: "standard",
          filter: ["lowercase"],
        },
      },
    },
  },
  mappings: {
    properties: {
      documentId: { type: "keyword" },
      currentVersionId: { type: "keyword" },
      caseId: { type: "keyword" },
      title: {
        type: "text",
        fields: { exact: { type: "text", analyzer: "english_exact" } },
      },
      description: { type: "text" },
      docType: { type: "keyword" },
      classification: { type: "keyword" },
      tags: { type: "keyword" },
      // Populated from extractText() + ner() once documentProcessing.processor.js
      // wires them up (both are currently stubs — see that file). Until then this
      // is indexed empty and search effectively runs on title/description/tags.
      extractedText: { type: "text" },
      entities: { type: "keyword" },
      fileName: { type: "text" },
      mimeType: { type: "keyword" },
      createdBy: { type: "keyword" },
      sealed: { type: "boolean" },
      deletedAt: { type: "date" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
};

// Idempotent — safe to call at worker/app startup. Does not touch the mapping
// of an index that already exists; ship mapping changes via a real reindex,
// same discipline as the drizzle/ migrations for Postgres.
export async function ensureDocumentsIndex() {
  const exists = await opensearch.indices.exists({ index: DOCUMENTS_INDEX });
  if (exists.statusCode === 200) return;
  await opensearch.indices.create({ index: DOCUMENTS_INDEX, body: MAPPING });
}