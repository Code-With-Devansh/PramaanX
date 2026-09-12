// A stand-in for bullmq's UnrecoverableError used when the real class isn't
// injected (unit tests, which don't install bullmq). src/worker.js passes the
// real one in so BullMQ actually skips retries; the name match is the fallback.
class UnrecoverableErrorFallback extends Error {
  constructor(message) {
    super(message);
    this.name = "UnrecoverableError";
  }
}

// Document-intelligence job processing, as a PURE factory over injected
// dependencies — same discipline as ledgerAnchor.processor.js: no top-level
// imports of the DB, storage, ClamAV or the OCR service, so the state-machine
// logic is unit-testable with fakes. src/worker.js wires the real singletons.
//
// processing_status state machine (document_versions + mirrored on
// document_extractions.status):
//
//   SCANNING --clean--> EXTRACTING --> INDEXING (NER) --> TAGGING --> READY
//   SCANNING --infected/disallowed--> QUARANTINED         (terminal, no retry)
//   any stage throws --> BullMQ retry; retries exhausted --> FAILED
//
// Every DB write commits atomically with its audit entry, mirroring the anchor
// worker (external calls outside the transaction, DB + audit inside).

const MAX_TEXT_AUDIT_CHARS = 0; // never put extracted text in the audit payload

// Drain a Readable into a single Buffer, refusing anything larger than `maxBytes`
// so a lying Content-Length can't blow up the worker's memory.
async function streamToBuffer(readable, maxBytes, TooLargeError) {
  const chunks = [];
  let total = 0;
  for await (const chunk of readable) {
    total += chunk.length;
    if (maxBytes && total > maxBytes) {
      throw new TooLargeError(`file exceeds processing limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// No-op collaborators so the pipeline is runnable before each real stage lands
// (built incrementally in src/processing/*). worker.js injects the real ones.
const passThroughScanner = { async scan() { return { clean: true, signature: null }; } };
const passThroughExtractor = async () => ({ text: "", method: "none", confidence: null, pageCount: null });
const passThroughNer = { async extract() { return []; } };
const passThroughTagger = { async tag() { return []; } };
const identityNormalize = (t) => t ?? "";

/**
 * Build the BullMQ processor for the `document-processing` queue.
 *
 * @param {{
 *   storage: { getObject: (key: string) => Promise<{ body: any }> },
 *   repo: typeof import("../repositories/documents.repo.js"),
 *   db: { transaction: (cb: (tx: any) => Promise<any>) => Promise<any> },
 *   recordAudit: Function,
 *   AuditAction: Record<string, string>,
 *   TargetType: Record<string, string>,
 *   indexDocumentVersion: Function,
 *   scanner?: { scan: (buf: Buffer, ctx: object) => Promise<{ clean: boolean, signature: string|null }> },
 *   extractText?: (input: { buffer: Buffer, mimeType: string, fileName: string }) => Promise<{ text: string, method: string, confidence: number|null, pageCount: number|null, mimeType?: string }>,
 *   nerPipeline?: { extract: (text: string) => Promise<Array<object>> },
 *   tagger?: { tag: (input: object) => Promise<Array<{ tag: string, confidence: number, source: string }>> },
 *   normalizeText?: (raw: string) => string,
 *   maxFileBytes?: number,
 * }} deps
 */
export function createDocumentProcessingProcessor({
  storage,
  repo,
  db,
  recordAudit,
  AuditAction,
  TargetType,
  indexDocumentVersion,
  scanner = passThroughScanner,
  extractText = passThroughExtractor,
  nerPipeline = passThroughNer,
  tagger = passThroughTagger,
  normalizeText = identityNormalize,
  maxFileBytes = 0,
  UnrecoverableError = UnrecoverableErrorFallback,
}) {
  return async function processDocument(job) {
    const { versionId, documentId, caseId, actor } = job.data;

    const version = await repo.getVersionById(versionId);
    if (!version) return { skipped: "version gone" };
    const doc = await repo.getDocumentById(documentId);
    if (!doc) return { skipped: "document gone" };

    // A version that already finished (e.g. a stale reconcile re-enqueue) is left
    // alone — READY/QUARANTINED are terminal.
    if (version.processingStatus === "READY" || version.processingStatus === "QUARANTINED") {
      return { skipped: `already ${version.processingStatus}` };
    }

    await db.transaction((tx) =>
      repo.ensureExtraction(tx, { versionId, documentId, status: "SCANNING" }),
    );
    await setStatus(db, repo, { versionId, status: "SCANNING" });

    const { body } = await storage.getObject(version.storageKey);
    const buffer = await streamToBuffer(body, maxFileBytes, UnrecoverableError);

    // ── Stage 1: ClamAV. Fail-CLOSED — a scanner error propagates so BullMQ
    // retries; nothing downstream runs without a clean verdict. ──────────────
    const scan = await scanner.scan(buffer, {
      versionId,
      declaredMimeType: version.mimeType,
      fileName: version.fileName,
    });
    if (scan?.clean === false) {
      await db.transaction(async (tx) => {
        await repo.setExtractionFields(tx, {
          versionId,
          fields: {
            status: "QUARANTINED",
            scannedClean: false,
            virusSignature: scan.signature ?? "unknown",
            mimeType: scan.mimeType ?? version.mimeType,
            error: `quarantined: ${scan.signature ?? "malware detected"}`,
            finishedAt: new Date(),
          },
        });
        await repo.setProcessingStatus(tx, { versionId, processingStatus: "QUARANTINED" });
        await recordAudit(tx, {
          actorId: actor,
          action: AuditAction.VERSION_PROCESSING_FAILED,
          targetType: TargetType.VERSION,
          targetId: versionId,
          ip: null,
          details: {
            documentId,
            caseId,
            reason: "quarantined",
            signature: scan.signature ?? null,
          },
        });
      });
      // Terminal: a malicious file will still be malicious on retry.
      throw new UnrecoverableError(`virus scan flagged version ${versionId}: ${scan.signature ?? "infected"}`);
    }

    await db.transaction((tx) =>
      repo.setExtractionFields(tx, {
        versionId,
        fields: {
          status: "EXTRACTING",
          scannedClean: true,
          mimeType: scan?.mimeType ?? version.mimeType,
        },
      }),
    );
    await setStatus(db, repo, { versionId, status: "EXTRACTING" });

    // ── Stage 2: text extraction (native parsers / PaddleOCR). ──────────────
    const extraction = await extractText({
      buffer,
      mimeType: scan?.mimeType ?? version.mimeType,
      fileName: version.fileName,
    });
    const text = normalizeText(extraction.text || "");

    await db.transaction((tx) =>
      repo.setExtractionFields(tx, {
        versionId,
        fields: {
          status: "INDEXING",
          extractedText: text,
          textChars: text.length,
          extractionMethod: extraction.method ?? "none",
          pageCount: extraction.pageCount ?? null,
          ocrConfidence:
            extraction.confidence == null ? null : String(extraction.confidence),
          mimeType: extraction.mimeType ?? scan?.mimeType ?? version.mimeType,
        },
      }),
    );
    await setStatus(db, repo, { versionId, status: "INDEXING" });

    // ── Stage 3: NER. ──────────────────────────────────────────────────────
    const entities = (await nerPipeline.extract(text)) ?? [];
    await db.transaction((tx) =>
      repo.replaceEntities(tx, { versionId, documentId, entities }),
    );
    await setStatus(db, repo, { versionId, status: "TAGGING" });
    await db.transaction((tx) =>
      repo.setExtractionFields(tx, { versionId, fields: { status: "TAGGING" } }),
    );

    // ── Stage 4: auto-tagging. ─────────────────────────────────────────────
    const tagResults = (await tagger.tag({ text, entities, doc })) ?? [];
    const plainTags = [...new Set(tagResults.map((t) => t.tag).filter(Boolean))];

    // ── Commit: READY + tags + audit, atomically. ─────────────────────────
    await db.transaction(async (tx) => {
      await repo.appendDocumentTags(tx, { documentId, tags: plainTags });
      await repo.setExtractionFields(tx, {
        versionId,
        fields: { status: "READY", tags: tagResults, error: null, finishedAt: new Date() },
      });
      await repo.setProcessingStatus(tx, { versionId, processingStatus: "READY" });
      await recordAudit(tx, {
        actorId: actor,
        action: AuditAction.VERSION_PROCESSED,
        targetType: TargetType.VERSION,
        targetId: versionId,
        ip: null,
        details: {
          documentId,
          caseId,
          method: extraction.method ?? "none",
          textChars: text.length,
          entitiesFound: entities.length,
          tagsAdded: plainTags,
        },
      });
    });

    // Best-effort: OpenSearch being briefly unavailable shouldn't fail the whole
    // job and re-flip a READY document back to FAILED. The reconciliation sweep
    // catches documents that silently missed indexing.
    try {
      await indexDocumentVersion({
        documentId,
        versionId,
        extractedText: text,
        entities: entityIndexValues(entities),
        tags: plainTags,
      });
    } catch (err) {
      console.error(
        { err: err?.message ?? err, documentId, versionId },
        "[processing] failed to index document, will not retry job",
      );
    }

    return {
      versionId,
      method: extraction.method ?? "none",
      entitiesFound: entities.length,
      tagsAdded: plainTags,
    };
  };
}

// Flat, de-duplicated entity strings for the OpenSearch `entities` keyword field.
function entityIndexValues(entities) {
  const out = new Set();
  for (const e of entities) {
    if (e?.value) out.add(e.value);
    if (e?.normalizedValue) out.add(e.normalizedValue);
  }
  return [...out];
}

async function setStatus(db, repo, { versionId, status }) {
  await db.transaction((tx) => repo.setProcessingStatus(tx, { versionId, processingStatus: status }));
}

/**
 * Build the terminal-failure handler: after BullMQ exhausts all attempts (or an
 * UnrecoverableError that wasn't the quarantine path), flip the row to FAILED
 * and write a VERSION_PROCESSING_FAILED audit entry. A version already
 * QUARANTINED/READY is left untouched.
 */
export function createProcessingFailureHandler({ repo, db, recordAudit, AuditAction, TargetType }) {
  return async function markProcessingFailed(job, err) {
    const { versionId, documentId, caseId, actor } = job.data;
    const version = await repo.getVersionById(versionId);
    if (!version) return;
    if (version.processingStatus === "QUARANTINED" || version.processingStatus === "READY") return;

    await db.transaction(async (tx) => {
      await repo.setProcessingStatus(tx, { versionId, processingStatus: "FAILED" });
      await repo.setExtractionFields(tx, {
        versionId,
        fields: { status: "FAILED", error: String(err?.message ?? err).slice(0, 2000), finishedAt: new Date() },
      });
      await recordAudit(tx, {
        actorId: actor,
        action: AuditAction.VERSION_PROCESSING_FAILED,
        targetType: TargetType.VERSION,
        targetId: versionId,
        ip: null,
        details: { documentId, caseId, reason: String(err?.message ?? err) },
      });
    });
  };
}

export { MAX_TEXT_AUDIT_CHARS };
