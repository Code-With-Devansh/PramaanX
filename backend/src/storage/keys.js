// Storage-key naming. Keys are opaque, carry no PII, and are immutable once
// written: a version's bytes never change, and an edit creates a NEW version
// with a NEW key. Case-prefixing keeps every object for a case under one
// prefix, which the court-ready evidence-bundle export relies on (list one
// prefix -> the whole case).
//
//   cases/{caseId}/{documentId}/{versionId}
//
// The ids are our own UUIDs, so keys are unique and unguessable without a random
// suffix. The caller must know the version id BEFORE upload (generate it
// app-side rather than relying on the DB default) so the key is stable and can
// be persisted to document_versions.storage_key.
export function versionStorageKey({ caseId, documentId, versionId }) {
  if (!caseId || !documentId || !versionId) {
    throw new Error(
      "versionStorageKey requires caseId, documentId and versionId",
    );
  }
  return `cases/${caseId}/${documentId}/${versionId}`;
}
