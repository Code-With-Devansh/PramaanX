import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createDocumentProcessingProcessor,
  createProcessingFailureHandler,
} from "./documentProcessing.processor.js";
// Plain label maps only — NOT ../audit/index.js, which boots the pg pool.
import { AuditAction, TargetType } from "../audit/actions.js";

// Fakes: db.transaction runs the callback with a sentinel tx; repo captures
// every write; storage hands back a small in-memory stream.
function makeDeps(overrides = {}) {
  const calls = {
    status: [],
    extraction: [],
    entities: [],
    tags: [],
    audits: [],
    indexed: [],
  };
  const TX = Symbol("tx");
  const db = { transaction: (cb) => cb(TX) };

  const version = {
    id: "v-1",
    documentId: "d-1",
    storageKey: "cases/c-1/d-1/v-1",
    mimeType: "application/pdf",
    fileName: "fir.pdf",
    processingStatus: "SCANNING",
    createdBy: "user-1",
  };
  const doc = { id: "d-1", caseId: "c-1", docType: "FIR", tags: [] };

  const repo = {
    getVersionById: async () => overrides.version ?? version,
    getDocumentById: async () => overrides.doc ?? doc,
    ensureExtraction: async (tx, a) => { assert.equal(tx, TX); calls.extraction.push(["ensure", a]); },
    setExtractionFields: async (tx, a) => { assert.equal(tx, TX); calls.extraction.push(["set", a.fields]); },
    setProcessingStatus: async (tx, a) => { assert.equal(tx, TX); calls.status.push(a.processingStatus); },
    replaceEntities: async (tx, a) => { assert.equal(tx, TX); calls.entities.push(a.entities); },
    appendDocumentTags: async (tx, a) => { assert.equal(tx, TX); calls.tags.push(a.tags); },
  };
  const recordAudit = async (tx, e) => { assert.equal(tx, TX); calls.audits.push(e); };
  const storage = {
    getObject: async () => ({ body: Readable.from([Buffer.from("hello world")]) }),
  };
  const indexDocumentVersion = async (a) => { calls.indexed.push(a); };

  const deps = {
    storage, repo, db, recordAudit, AuditAction, TargetType, indexDocumentVersion,
    scanner: overrides.scanner ?? { scan: async () => ({ clean: true, signature: null, mimeType: "application/pdf" }) },
    extractText: overrides.extractText ?? (async () => ({ text: "Amit Kumar", method: "pdf_native", confidence: null, pageCount: 1 })),
    nerPipeline: overrides.nerPipeline ?? { extract: async () => [{ type: "PERSON", value: "Amit Kumar", confidence: 0.9, source: "regex" }] },
    tagger: overrides.tagger ?? { tag: async () => [{ tag: "fir", confidence: 1, source: "rules" }] },
    normalizeText: (t) => t.trim(),
    maxFileBytes: 1024,
  };
  return { deps, calls };
}

const job = () => ({ id: "v-1", data: { versionId: "v-1", documentId: "d-1", caseId: "c-1", actor: "user-1" } });

test("clean file walks SCANNING->EXTRACTING->INDEXING->TAGGING->READY, persists results, indexes", async () => {
  const { deps, calls } = makeDeps();
  const process = createDocumentProcessingProcessor(deps);

  const result = await process(job());

  assert.deepEqual(calls.status, ["SCANNING", "EXTRACTING", "INDEXING", "TAGGING", "READY"]);
  assert.deepEqual(calls.entities.at(-1), [
    { type: "PERSON", value: "Amit Kumar", confidence: 0.9, source: "regex" },
  ]);
  assert.deepEqual(calls.tags.at(-1), ["fir"]);
  const ready = calls.extraction.map(([, f]) => f).find((f) => f && f.status === "READY");
  assert.ok(ready && ready.finishedAt instanceof Date);
  assert.equal(calls.audits.at(-1).action, AuditAction.VERSION_PROCESSED);
  assert.equal(calls.indexed.length, 1);
  assert.equal(calls.indexed[0].extractedText, "Amit Kumar");
  assert.deepEqual(calls.indexed[0].tags, ["fir"]);
  assert.equal(result.entitiesFound, 1);
});

test("infected file -> QUARANTINED, no extraction/NER, UnrecoverableError, audit reason=quarantined", async () => {
  const { deps, calls } = makeDeps({
    scanner: { scan: async () => ({ clean: false, signature: "Eicar-Test-Signature", mimeType: "application/pdf" }) },
  });
  const process = createDocumentProcessingProcessor(deps);

  await assert.rejects(() => process(job()), (e) => e.name === "UnrecoverableError");

  assert.deepEqual(calls.status, ["SCANNING", "QUARANTINED"]);
  assert.equal(calls.entities.length, 0);
  assert.equal(calls.tags.length, 0);
  assert.equal(calls.indexed.length, 0);
  const q = calls.extraction.map(([, f]) => f).find((f) => f && f.status === "QUARANTINED");
  assert.equal(q.virusSignature, "Eicar-Test-Signature");
  assert.equal(calls.audits.at(-1).details.reason, "quarantined");
});

test("a scanner transport error propagates (BullMQ retries) and nothing terminal is written", async () => {
  const { deps, calls } = makeDeps({
    scanner: { scan: async () => { throw new Error("clamd timeout"); } },
  });
  const process = createDocumentProcessingProcessor(deps);

  await assert.rejects(() => process(job()), /clamd timeout/);
  assert.ok(!calls.status.includes("READY") && !calls.status.includes("QUARANTINED"));
});

test("failure handler flips FAILED + audit, but leaves a QUARANTINED version alone", async () => {
  const { deps, calls } = makeDeps();
  const mark = createProcessingFailureHandler(deps);
  await mark(job(), new Error("boom after retries"));
  assert.ok(calls.status.includes("FAILED"));
  assert.equal(calls.audits.at(-1).action, AuditAction.VERSION_PROCESSING_FAILED);

  const q = makeDeps({ version: { id: "v-1", processingStatus: "QUARANTINED" } });
  const mark2 = createProcessingFailureHandler(q.deps);
  await mark2(job(), new Error("late"));
  assert.equal(q.calls.status.length, 0, "no status write for an already-terminal version");
});
