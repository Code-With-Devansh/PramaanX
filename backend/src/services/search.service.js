import { opensearch } from "../search/opensearch.client.js";
import { DOCUMENTS_INDEX } from "../search/documents.index.js";
import { getDocumentById } from "../repositories/documents.repo.js";
import { authorize } from "../lib/authorize.js";

// ── indexing (called from documentProcessing.processor.js) ────────────────────
//
// We index by documentId (not versionId): a document has exactly one *current*
// version worth searching, so a re-index on every new version just overwrites
// the same _id rather than accumulating stale historical copies in the index.
//
// extractedText/entities/tags are passed in directly by the caller (the
// processing job already has them in memory right after ocrProcessing()/ner()/
// autoTagging() run) rather than re-read from Postgres — today nothing persists
// extractedText to a column, so this is the only place it exists. If OCR text
// ever needs to be re-derivable independent of a live processing job (e.g. to
// backfill/reindex after a mapping change), it'll need its own column — worth
// doing before this goes to production, not required for a first cut.
export async function indexDocumentVersion({
  documentId,
  versionId,
  extractedText = "",
  entities = [],
  tags = [],
}) {
  const doc = await getDocumentById(documentId);
  if (!doc) return; // deleted/racing with a delete — nothing to index

  // The OpenSearch mapping's `entities` field is `keyword` — a flat list of
  // matchable strings (it's one of searchDocuments()'s multi_match fields),
  // not the richer { type, value } shape ner() returns for the audit log.
  // Flatten to just the values here; accept bare strings too so this doesn't
  // break if a caller ever passes those directly.
  const entityValues = entities
    .map((e) => (typeof e === "string" ? e : e?.value))
    .filter(Boolean);

  await opensearch.index({
    index: DOCUMENTS_INDEX,
    id: documentId,
    body: {
      documentId: doc.id,
      currentVersionId: versionId,
      caseId: doc.caseId,
      title: doc.title,
      description: doc.description ?? "",
      docType: doc.docType,
      classification: doc.classification,
      tags: Array.from(new Set([...(doc.tags ?? []), ...tags])),
      extractedText,
      entities: entityValues,
      sealed: doc.sealed,
      createdBy: doc.createdBy,
      deletedAt: doc.deletedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
    refresh: false,
  });
}

// Soft-delete and hard document lifecycle changes both flow through here.
// Called wherever documents.service marks deletedAt (not wired up yet — see
// the note in this file's module doc comment / the follow-up PR).
export async function removeDocumentFromIndex(documentId) {
  try {
    await opensearch.delete({ index: DOCUMENTS_INDEX, id: documentId });
  } catch (err) {
    if (err?.meta?.statusCode !== 404) throw err;
  }
}

// ── search ──────────────────────────────────────────────────────────────────
//
// Two-phase authorization, deliberately NOT index-time ACL fields:
//   1. OpenSearch returns ranked CANDIDATE documentIds — it knows nothing about
//      who's asking.
//   2. Each candidate is re-checked with the exact same authorize() /
//      canAccessCase() path every other document read goes through
//      (src/lib/authorize.js), so search can never surface — even in a
//      "found 1 result" sense — a document the same user couldn't open via
//      GET /documents/:id. One enforcement point, not two ABAC implementations
//      to keep in sync.
//
// Trade-off: because filtering happens after the OpenSearch query, a page can
// come back short (or empty) even though more authorized matches exist further
// into OpenSearch's ranking. We over-fetch (searchMultiplier) to absorb the
// common case; it's not a correctness guarantee at scale. If this ever shows
// up as "page 2 feels wrong" in practice, the fix is denormalizing jurisdiction
// + an allowed-viewer set into the index and filtering in the OpenSearch query
// itself — bigger change, deliberately deferred until proven necessary.
const SEARCH_MULTIPLIER = 3;

export async function searchDocuments({ user, q, caseId, docType, classification, tags, page = 1, pageSize = 20 }) {
  const must = [];
  if (q) {
    must.push({
      multi_match: {
        query: q,
        fields: ["title^3", "title.exact^2", "tags^2", "description", "extractedText", "entities"],
        fuzziness: "AUTO",
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  const filter = [];
  // Soft-deleted docs carry a deletedAt value once documents.service wires up
  // removeDocumentFromIndex() on delete; excluding them here too is belt-and-
  // suspenders in case a delete event is ever missed.
  const mustNot = [{ exists: { field: "deletedAt" } }];
  if (caseId) filter.push({ term: { caseId } });
  if (docType) filter.push({ term: { docType } });
  if (classification) filter.push({ term: { classification } });
  if (tags?.length) filter.push({ terms: { tags } });

  const candidateSize = pageSize * SEARCH_MULTIPLIER;
  const result = await opensearch.search({
    index: DOCUMENTS_INDEX,
    body: {
      query: { bool: { must, filter, must_not: mustNot } },
      size: candidateSize,
      _source: ["documentId", "title", "docType", "classification", "tags", "caseId"],
    },
  });

  const hits = result.body.hits.hits;

  // Re-check access per candidate, in parallel, using the real authorize() path.
  const checks = await Promise.allSettled(
    hits.map((hit) =>
      authorize({ user, action: "document:read", resource: { documentId: hit._source.documentId } }),
    ),
  );

  const authorized = hits.filter((_, i) => checks[i].status === "fulfilled");
  const total = authorized.length; // approximate — see module doc comment above
  const pageHits = authorized.slice((page - 1) * pageSize, page * pageSize);

  return {
    total,
    page,
    pageSize,
    results: pageHits.map((hit) => ({
      documentId: hit._source.documentId,
      title: hit._source.title,
      docType: hit._source.docType,
      classification: hit._source.classification,
      tags: hit._source.tags,
      caseId: hit._source.caseId,
      score: hit._score,
    })),
  };
}