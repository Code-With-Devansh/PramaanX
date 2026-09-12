# Document Intelligence Pipeline

Async post-upload processing for every document version:

```
Upload API ──▶ Object storage ──▶ BullMQ queue ──▶ Processing worker
                                                     ├── 1. ClamAV virus scan
                                                     ├── 2. Text extraction / PaddleOCR
                                                     ├── 3. NER (entity extraction)
                                                     └── 4. Auto-tagging
                                                              │
                                                     PostgreSQL  +  OpenSearch
                                                              │
                                                   REST API · full-text search · UI
```

Implements DESIGN §11 ("AI / Intelligent Features"). Every stage is modular and
swappable; the worker never touches a file until ClamAV clears it.

- [1. Architecture & data flow](#1-architecture--data-flow)
- [2. Every file, and why it exists](#2-every-file-and-why-it-exists)
- [3. How the files connect](#3-how-the-files-connect)
- [4. Database schema](#4-database-schema)
- [5. Sidecar services (ClamAV, PaddleOCR)](#5-sidecar-services)
- [6. Setup](#6-setup)
- [7. Testing](#7-testing)
- [8. API reference](#8-api-reference)
- [9. Configuration reference](#9-configuration-reference)
- [10. Processing state machine](#10-processing-state-machine)
- [11. Failure handling, retries, stuck jobs](#11-failure-handling-retries-stuck-jobs)
- [12. Extension points](#12-extension-points)
- [13. Commit plan (block by block)](#13-commit-plan-block-by-block)
- [14. Known limitations / TODO](#14-known-limitations--todo)

---

## 1. Architecture & data flow

1. **Upload** — `POST /cases/:caseId/documents` (or `/documents/:id/versions`,
   or `.../restore`) hits `documents.service.js`. It stores the bytes in object
   storage, inserts an **immutable** `document_versions` row with
   `processing_status = 'SCANNING'` + an audit entry (one transaction), then —
   **after commit** — enqueues two independent jobs:
   - `ledger-anchor` (pre-existing: blockchain hash anchoring)
   - `document-processing` (this feature)

   Both enqueues are **fail-open**: a Redis hiccup never fails the upload; the
   row is left in a non-terminal state for the reconciler to pick up.

2. **Queue** — `documentProcessing.queue.js` adds a job to the BullMQ
   `document-processing` queue with `jobId = versionId` (idempotent: a retried
   request or a reconcile re-enqueue collapses onto the same job).

3. **Worker** — `src/worker.js` runs a second `Worker` (alongside the ledger
   worker) that executes `processDocument(job)` from
   `documentProcessing.processor.js`. The processor is a **pure factory**: it
   holds no infra imports; `worker.js` injects the real storage / DB / ClamAV /
   OCR / NER / tagger singletons, tests inject fakes.

4. **Stages** (each writes progress to Postgres before the next begins):

   | # | Stage | Module | Sets `processing_status` |
   |---|-------|--------|--------------------------|
   | 1 | Virus scan | `processing/clamav.js` | `SCANNING` → (infected) `QUARANTINED` |
   | 2 | Extraction | `processing/extract/index.js` + `processing/ocr/paddleClient.js` + `processing/normalize.js` | `EXTRACTING` |
   | 3 | NER | `processing/ner/index.js` + `processing/ner/regexProvider.js` | `INDEXING` |
   | 4 | Auto-tagging | `processing/tagging/index.js` + `processing/tagging/ruleTagger.js` | `TAGGING` |
   | — | Commit + index | processor + `services/search.service.js` | `READY` |

5. **Storage of results**
   - `document_extractions` — one row per version: extracted text, method,
     ClamAV verdict, OCR confidence, page count, tag provenance, per-stage
     status, error.
   - `document_entities` — normalized NER output, one row per mention.
   - `documents.tags` — plain tag strings unioned in (existing column).
   - OpenSearch `dms-documents` — `extractedText` + `entities` + `tags` fields
     become populated (they were indexed empty before).

6. **Read** — `GET /documents/:id/versions/:vid/extraction` returns the results;
   `GET /search` now matches on extracted text and entities.

---

## 2. Every file, and why it exists

**37 pipeline files** (16 modified, 21 new) **+ 4 more** added for testing/docs
(§L below + this doc). Grouped by role.

### A. Database schema & migration (5)

| File | M/N | Significance |
|------|-----|--------------|
| `src/db/schema/enums.js` | M | Adds `EXTRACTING`, `TAGGING`, `QUARANTINED` to the `processing_status` pgEnum. |
| `src/db/schema/documentIntelligence.js` | **N** | Drizzle definitions for `document_extractions` (1/version, upsert key `version_id`) and `document_entities` (normalized NER, `type` is free-form `text` so new entity types need no migration). |
| `src/db/schema/index.js` | M | Re-exports the new schema file so drizzle + repos see the tables. |
| `drizzle/0003_document_intelligence.sql` | **N** | Hand-written migration (same "custom migration" precedent as `0002_version_control.sql`): `ALTER TYPE` for the enum values + `CREATE TABLE` × 2 + FKs + indexes. Enum-literal-safe partial index (`status::text not in (...)`). |
| `drizzle/meta/_journal.json` | M | New journal entry `idx 3` so `drizzle-kit migrate` runs `0003`. |
| `drizzle/meta/0003_snapshot.json` | **N** | Copy of `0002` snapshot (matches the `0002` precedent; snapshots are only used by `generate`, not `migrate`). |

### B. Config & environment (3)

| File | M/N | Significance |
|------|-----|--------------|
| `src/config/index.js` | M | New `processing` block: queue name, attempts/backoff/concurrency, `stuckAfterMs`/`reconcileEveryMs`, `maxFileBytes`, `clamav {host,port,timeoutMs}`, `ocr {url,timeoutMs,lang,minCharsPerPage}`, `nerProviders[]`, `taggingPipeline[]`. |
| `.env.example` | M | Documents every `PROCESSING_*`, `CLAMAV_*`, `OCR_*`, `NER_PROVIDERS`, `TAGGING_PIPELINE` var. |
| `package.json` (+ `package-lock.json`) | M | Adds runtime deps: `clamscan`, `file-type`, `mammoth`, `pdf-parse`, `xlsx`. |

### C. Queue & worker wiring (4)

| File | M/N | Significance |
|------|-----|--------------|
| `src/jobs/documentProcessing.queue.js` | M | `enqueueDocumentProcessing({versionId,documentId,caseId,actor,storageKey,mimeType})`. Config-driven job opts, `jobId = versionId`, fail-open. Was a stub that nothing called. |
| `src/jobs/documentProcessing.processor.js` | M | The heart. `createDocumentProcessingProcessor(deps)` → runs the 4 stages + state machine + audit + index; `createProcessingFailureHandler(deps)` → terminal failure. Previously 4 empty stub functions. |
| `src/jobs/documentProcessing.reconcile.js` | **N** | `reconcileStuckProcessing()` re-enqueues versions stuck non-terminal > `stuckAfterMs`; `startProcessingReconciler()` runs it on an interval. Mirrors the ledger's pending-anchor sweeper. |
| `src/worker.js` | M | Constructs the 2nd `Worker`, injects all real collaborators into the processor, wires `completed`/`failed`/`error` listeners + terminal-failure handler, calls `ensureDocumentsIndex()`, starts the reconciler, extends graceful shutdown. |

### D. Stage 1 — virus scan (1)

| File | M/N | Significance |
|------|-----|--------------|
| `src/processing/clamav.js` | **N** | `createClamAvScanner({host,port,timeoutMs})` → `scan(buffer, ctx)`. A minimal **clamd `INSTREAM`** TCP client (no local binary, no temp files). Also does magic-byte type sniffing with `file-type` and an allow-list: a file whose real type is disallowed is treated exactly like a detection. **Fail-closed**: transport/protocol errors throw (job retries); only a real positive or disallowed type returns `{clean:false}`. |

### E. Stage 2 — text extraction (4)

| File | M/N | Significance |
|------|-----|--------------|
| `src/processing/normalize.js` | **N** | `normalizeText(raw)` — the single funnel every extractor's output passes through: NFC, strip control/zero-width chars, de-hyphenate OCR line wraps, collapse whitespace, cap blank lines. Keeps casing & punctuation (NER needs them). |
| `src/processing/ocr/paddleClient.js` | **N** | `createPaddleOcrClient({url,timeoutMs,lang})` → `ocr({buffer,fileName,mimeType})`. `fetch`-based multipart client for the `ocr` sidecar. `AbortController` timeout + one retry (first call races model load). |
| `src/processing/extract/index.js` | **N** | `createExtractor({ocrClient,minCharsPerPage})` → `extractText({buffer,mimeType,fileName})`. Dispatches on sniffed MIME + filename fallback: PDF → `pdf-parse` with a scanned-vs-text heuristic (< `minCharsPerPage` chars/page → OCR fallback, keeping native text as a floor); image → OCR; DOCX → `mammoth`; XLSX/XLS → `xlsx` (per-sheet CSV); txt/csv/md → utf-8; else → `{method:'none', text:''}`. Heavy libs are **lazy `import()`ed**. |
| `src/processing/extract/index.test.js` | **N** | Dispatch tests (plaintext, image→OCR, extension fallback, unknown→none). |

### F. Stage 3 — NER (3)

| File | M/N | Significance |
|------|-----|--------------|
| `src/processing/ner/regexProvider.js` | **N** | `regexNerProvider` — deterministic, dependency-free. Extracts `EMAIL`, `URL`, `PHONE` (→ E.164), `MONEY`, `DATE` (→ ISO-8601, rejects impossible dates), `VEHICLE` (Indian plates), `LEGAL_SECTION` (IPC/BNS/CrPC §), `CASE_REF` (FIR/Crime No.), plus cue-word `PERSON`/`ORGANIZATION`/`LOCATION` at low confidence. All patterns linear (ReDoS-safe). |
| `src/processing/ner/index.js` | **N** | `createNerPipeline({providerIds,registry})` — runs providers in order, de-dupes by `type + canonical value`, later/higher-confidence provider wins, a throwing provider is skipped. `DEFAULT_NER_REGISTRY` currently maps `"regex"` → the provider above. This is the seam for a spaCy/LLM provider. |
| `src/processing/ner/regexProvider.test.js`, `src/processing/ner/index.test.js` | **N** | Sample-sentence extraction + span integrity; pipeline merge/dedupe/skip. (2 files) |

### G. Stage 4 — auto-tagging (3)

| File | M/N | Significance |
|------|-----|--------------|
| `src/processing/tagging/ruleTagger.js` | **N** | `ruleTagger` — three signals: docType (`FIR`→`fir`), entity presence (`MONEY`→`financial`, `VEHICLE`→`vehicle`, `LEGAL_SECTION`→`ipc-420`), keyword lexicon (`bail`, `custody`, `arrest`, `post-mortem`, `forensic`, `warrant`, …). Emits `{tag,confidence,source}` as lowercase slugs. |
| `src/processing/tagging/index.js` | **N** | `createTagger({stageIds,registry,maxTags})` — unions taggers, keeps highest confidence per tag, caps count. `DEFAULT_TAGGER_REGISTRY` maps `"rules"` → the tagger above. Seam for a classifier/LLM tagger. |
| `src/processing/tagging/ruleTagger.test.js` | **N** | docType/entity/keyword tagging + pipeline dedupe/cap. |

### H. Persistence layer (1)

| File | M/N | Significance |
|------|-----|--------------|
| `src/repositories/documents.repo.js` | M | New helpers: `ensureExtraction`, `setExtractionFields`, `getExtractionByVersion`, `replaceEntities` (delete-then-insert per version = idempotent re-run), `listEntitiesByVersion`, `listStuckExtractions`. Reuses existing `setProcessingStatus`, `appendDocumentTags`, `getVersionById`, `getDocumentById`. |

### I. Upload + read API (4)

| File | M/N | Significance |
|------|-----|--------------|
| `src/services/documents.service.js` | M | (a) `createDocument`/`addVersion`/`restoreVersion` stop forcing `processing_status: 'READY'` and call `enqueueDocumentProcessing` after commit. (b) New `getVersionExtraction(documentId, versionId, {includeText})` — reads `document_extractions` + `document_entities`, returns the results DTO. |
| `src/controllers/documents.controller.js` | M | New `getVersionExtraction` handler — `authorize("document:read")` then delegates; `?includeText=true` opt-in for raw text. |
| `src/routes/documents.route.js` | M | New route `GET /documents/:id/versions/:vid/extraction`. |
| `src/jobs/documentProcessing.processor.test.js` | **N** | Processor state-machine tests (clean walk, quarantine, transient-error retry, failure handler). |

### J. Sidecar services (5)

| File | M/N | Significance |
|------|-----|--------------|
| `docker-compose.dev.yml` | M | Adds `clamav` (image `clamav/clamav:1.3`, healthcheck) and `ocr` (built from `services/ocr/`) services; worker gains MinIO + OpenSearch + `CLAMAV_*` + `OCR_URL` env and `depends_on` those services; new named volumes `clamav_data`, `ocr_models`. |
| `docker-compose.yml` (prod) | M | Same two services + worker env, prod-shaped. |
| `services/ocr/Dockerfile` | **N** | `python:3.11-slim` + poppler + `paddleocr`/`paddlepaddle`/`fastapi`. |
| `services/ocr/requirements.txt` | **N** | Pinned Python deps. |
| `services/ocr/app.py` | **N** | Tiny FastAPI app: `GET /health`, `POST /ocr` (multipart file + `lang`) → `{text, confidence, pages}`. Handles PDF (via `pdf2image`) and images. Stateless — all orchestration lives in the Node worker. |

### K. Normalize test (1)

| File | M/N | Significance |
|------|-----|--------------|
| `src/processing/normalize.test.js` | **N** | de-hyphenation, whitespace collapse, control/zero-width stripping, CRLF. |

### L. Test tooling (2, added alongside this doc)

| File | M/N | Significance |
|------|-----|--------------|
| `scripts/dev-seed.mjs` | **N** | Dev-only fixture seeder + access-token minter. Creates an org/jurisdiction/demo-investigator user/demo case and mints a real, Redis-registered access token — so `Authorization: Bearer …` works against every route without the (unrelated) full login/MFA/governance-provisioning flow. Idempotent. |
| `scripts/generate-ocr-samples.py` | **N** | Generates a PNG + a rasterized PDF with **no embedded text layer** (Pillow only) — synthetic "scanned document" fixtures that force the OCR path end to end. |
| `docs/TESTING_DOCUMENT_INTELLIGENCE.md` | **N** | The hands-on, copy-pasteable test walkthrough (see [§7](#7-testing)). |

### Untouched but now load-bearing (reference only)

- `src/search/documents.index.js` — the `dms-documents` mapping already had
  `extractedText` (text) and `entities` (keyword) fields waiting to be filled.
- `src/services/search.service.js` — `indexDocumentVersion({documentId, versionId,
  extractedText, entities, tags})` was already called by the processor; it now
  receives real data.
- `src/jobs/connection.js` — the shared BullMQ Redis connection.
- `src/storage/*` — `storage.getObject(key)` streams bytes to the worker.
- `src/audit/*` — `recordAudit` + `AuditAction.VERSION_PROCESSED` /
  `VERSION_PROCESSING_FAILED` (already defined).

---

## 3. How the files connect

```
                    HTTP
routes/documents.route.js
        │  POST /cases/:caseId/documents , /documents/:id/versions , .../restore
        ▼
controllers/documents.controller.js
        ▼
services/documents.service.js ──(store bytes)──▶ storage/*  ──▶ MinIO/S3
        │  INSERT document_versions (status=SCANNING) + audit  [one tx]
        │  after commit, fail-open:
        ├───▶ jobs/ledger.queue.js         (pre-existing)
        └───▶ jobs/documentProcessing.queue.js  ──▶ Redis (BullMQ "document-processing")
                                                        │
                                                        ▼
                                              src/worker.js  (2nd Worker)
                                                        │ injects:
                                                        │  storage, repo, db, recordAudit,
                                                        │  indexDocumentVersion,
                                                        │  scanner  = processing/clamav.js
                                                        │  extractText = processing/extract/index.js
                                                        │              + processing/ocr/paddleClient.js ──▶ ocr sidecar
                                                        │  normalizeText = processing/normalize.js
                                                        │  nerPipeline = processing/ner/index.js
                                                        │              + processing/ner/regexProvider.js
                                                        │  tagger = processing/tagging/index.js
                                                        │         + processing/tagging/ruleTagger.js
                                                        ▼
                                    jobs/documentProcessing.processor.js
                                       │ stage 1  scanner.scan(buf) ─────────▶ clamav sidecar (TCP 3310)
                                       │ stage 2  extractText(...)   ─────────▶ pdf-parse / mammoth / xlsx / ocr sidecar
                                       │ stage 3  nerPipeline.extract(text)
                                       │ stage 4  tagger.tag({text,entities,doc})
                                       │ each step:
                                       ▼
                        repositories/documents.repo.js
                           ensureExtraction / setExtractionFields / setProcessingStatus
                           replaceEntities / appendDocumentTags
                                       │
                                       ▼
                        Postgres: document_versions.processing_status
                                  document_extractions   (text, method, verdict, tags, status)
                                  document_entities       (normalized NER rows)
                                  documents.tags          (plain strings)
                                  audit_log               (VERSION_PROCESSED)
                                       │
                                       ▼ best-effort
                        services/search.service.js#indexDocumentVersion ──▶ OpenSearch dms-documents

                    jobs/documentProcessing.reconcile.js (setInterval in worker.js)
                        listStuckExtractions() ──▶ re-enqueue stuck versions

READ PATH
routes/documents.route.js  GET /documents/:id/versions/:vid/extraction
        ▼
controllers/documents.controller.js#getVersionExtraction
        ▼
services/documents.service.js#getVersionExtraction
        ▼  repo.getExtractionByVersion + repo.listEntitiesByVersion
Postgres

routes/search.route.js  GET /search  ──▶ services/search.service.js ──▶ OpenSearch
        (now matches extractedText + entities)
```

**Dependency-injection boundary:** `documentProcessing.processor.js` and every
`src/processing/*` module import **no** DB / Redis / storage / network singleton.
`src/worker.js` is the only place the real ones are wired. That is what makes the
whole pipeline unit-testable without infra (see [§7](#7-testing)).

---

## 4. Database schema

Migration: `drizzle/0003_document_intelligence.sql` — run with `npm run migrate`.

### `processing_status` enum (extended)

`SCANNING`, `OCR`*, `EXTRACTING`, `INDEXING`, `TAGGING`, `READY`, `QUARANTINED`, `FAILED`
(`OCR` kept for back-compat, unused by the new pipeline).

### `document_extractions` — one row per version

| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `version_id` | uuid **unique** FK→`document_versions` | idempotency key; processor upserts on it |
| `document_id` | uuid FK→`documents` | denormalized |
| `status` | `processing_status` | per-stage mirror of the version's status |
| `extraction_method` | text | `pdf_native` \| `ocr_paddle` \| `docx` \| `xlsx` \| `plaintext` \| `none` |
| `mime_type` | text | **sniffed** type (may differ from client-declared) |
| `extracted_text` | text | normalized |
| `text_chars` | integer | |
| `page_count` | integer null | |
| `ocr_confidence` | numeric(5,4) null | mean OCR confidence when `ocr_paddle` |
| `tags` | jsonb `[]` | `[{tag,confidence,source}]` provenance |
| `scanned_clean` | boolean | ClamAV verdict; stays false until the scan passes |
| `virus_signature` | text null | set on `QUARANTINED` |
| `error` | text null | set on `FAILED` |
| `started_at` / `finished_at` / `created_at` / `updated_at` | timestamptz | |

Indexes: `unique(version_id)`, `(document_id)`, partial `(status)` where not terminal.

### `document_entities` — normalized NER output (DESIGN §10's `entities` table)

| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `version_id` | uuid FK→`document_versions` | |
| `document_id` | uuid FK→`documents` | |
| `type` | **text** | `PERSON`, `ORGANIZATION`, `LOCATION`, `DATE`, `EMAIL`, `PHONE`, `MONEY`, `LEGAL_SECTION`, `VEHICLE`, `CASE_REF`, `URL`, … — **open set, no enum** |
| `value` | text | raw matched span |
| `normalized_value` | text null | E.164 phone, ISO date, lowercased email, … |
| `confidence` | numeric(5,4) | |
| `start_offset` / `end_offset` | integer null | character span in the normalized text |
| `source` | text | provider id (`regex`, later `spacy`/`llm`) |
| `created_at` | timestamptz | |

Indexes: `(version_id)`, `(document_id, type)`, `(type, value)`.
Re-run = **delete all rows for `version_id`, then re-insert** (idempotent).

---

## 5. Sidecar services

### `clamav` (docker-compose service)

- Image `clamav/clamav:1.3`. Exposes clamd on TCP **3310** (internal network only).
- First boot downloads signature DBs (~1–2 min) — the compose healthcheck
  (`clamdcheck.sh`) gates the `worker` until clamd answers.
- The worker talks to it via `src/processing/clamav.js` using the raw
  `zINSTREAM` protocol — no `clamscan` binary in the worker image.
- Volume `clamav_data` persists the signature DBs across restarts.

### `ocr` (docker-compose service, built from `services/ocr/`)

- FastAPI + PaddleOCR, CPU-only, port **8000** (internal only), **no outbound
  network** needed at runtime.
- `POST /ocr` — multipart `file` (+ optional `lang` form field) → JSON
  `{ text, confidence, pages }`. PDFs are rasterized page-by-page with
  `pdf2image`/poppler; images go straight in.
- `GET /health` — used by the compose healthcheck.
- Models download to `/root/.paddleocr` on the **first** OCR request; the
  `ocr_models` volume persists them.
- The Node worker calls it via `src/processing/ocr/paddleClient.js`.

---

## 6. Setup

### 6.1 Dependencies

```bash
# Node deps are installed inside the containers on `npm run dev`; to install
# locally (for `node --test` / editor tooling):
npm install
```

New runtime deps: `clamscan`, `file-type`, `mammoth`, `pdf-parse`, `xlsx`
(already in `package.json` / `package-lock.json`).

### 6.2 Environment

Copy the new vars from `.env.example` into your `.env`. Sensible defaults are
baked in; the ones you might change:

```bash
PROCESSING_ENABLED=true          # master switch (false = uploads skip the pipeline)
PROCESSING_CONCURRENCY=2
CLAMAV_HOST=clamav
OCR_URL=http://ocr:8000
OCR_MIN_CHARS_PER_PAGE=100       # PDF scanned-vs-text threshold
NER_PROVIDERS=regex              # comma-separated, ordered
TAGGING_PIPELINE=rules
```

### 6.3 Database migration

```bash
npm run migrate      # applies drizzle/0003_document_intelligence.sql
```

Verify:

```sql
\d document_extractions
\d document_entities
SELECT unnest(enum_range(NULL::processing_status));   -- includes EXTRACTING/TAGGING/QUARANTINED
```

### 6.4 Run the stack

```bash
npm run dev          # postgres, redis, minio, opensearch, clamav, ocr, migrate, api, worker
```

First `up` builds the PaddleOCR image (a few minutes) and ClamAV downloads
signatures. Watch readiness:

```bash
docker compose -f docker-compose.dev.yml ps          # clamav + ocr "healthy"
docker compose -f docker-compose.dev.yml logs -f worker
#  [processing] worker up on queue document-processing (concurrency=2, enabled=true)
```

---

## 7. Testing

> **Full click-by-click walkthrough** (start the stack, mint a test token
> without the login/MFA flow, upload a safe file / an EICAR "virus" demo file /
> a scanned document, read back every result, troubleshooting table):
> **[TESTING_DOCUMENT_INTELLIGENCE.md](TESTING_DOCUMENT_INTELLIGENCE.md)**.
> The summary below is the quick reference; that doc is the one to follow
> top-to-bottom the first time.

### 7.1 Unit tests (no infra required)

The pipeline modules use `node:test` (same as `src/jobs/ledgerAnchor.processor.test.js`):

```bash
node --test \
  src/jobs/documentProcessing.processor.test.js \
  src/processing/normalize.test.js \
  src/processing/extract/index.test.js \
  src/processing/ner/regexProvider.test.js \
  src/processing/ner/index.test.js \
  src/processing/tagging/ruleTagger.test.js
```

Expected: **25 passing**. Coverage:

| Test file | Verifies |
|-----------|----------|
| `documentProcessing.processor.test.js` | status walk `SCANNING→EXTRACTING→INDEXING→TAGGING→READY`; infected → `QUARANTINED` + `UnrecoverableError` + no downstream work; scanner transport error → propagates (retry), nothing terminal; failure handler → `FAILED` + audit, skips already-terminal versions |
| `normalize.test.js` | de-hyphenation, whitespace/newline collapse, control/zero-width stripping, empty input |
| `extract/index.test.js` | dispatch: plaintext native, image→OCR, extension fallback, unknown→`none` |
| `ner/regexProvider.test.js` | DESIGN §11 sample sentence → all entity types with correct normalization + spans; impossible dates rejected |
| `ner/index.test.js` | multi-provider merge/dedupe, higher-trust wins, throwing provider skipped, default registry |
| `tagging/ruleTagger.test.js` | docType + entity + keyword tags; pipeline dedupe + confidence + cap |

> `npm test` runs **Jest** against `test/*.test.js` (route/integration tests).
> The `node:test`-based pipeline specs are run with `node --test` as above.

### 7.2 End-to-end (Docker)

```bash
npm run dev
# wait for clamav + ocr healthy, worker "up on queue document-processing"
```

**Get an auth cookie** (dev shim — `middlewares/currentUser.js` uses
`DEV_USER_ID`; if your build requires login, log in first and reuse the cookie).
Below assumes `$C` holds your cookie jar and `$CASE` an existing case id.

**A. Text PDF → native extraction**

```bash
curl -s -b $C -F file=@sample-text.pdf \
  -F 'metadata={"title":"Text FIR","docType":"FIR","classification":"RESTRICTED"}' \
  http://localhost:3000/api/v1/cases/$CASE/documents | tee /tmp/doc.json

DOC=$(jq -r .id /tmp/doc.json); VID=$(jq -r .currentVersionId /tmp/doc.json)

# poll status
watch -n1 "curl -s -b $C http://localhost:3000/api/v1/documents/$DOC/versions/$VID | jq .processingStatus"
# SCANNING -> EXTRACTING -> INDEXING -> TAGGING -> READY

curl -s -b $C "http://localhost:3000/api/v1/documents/$DOC/versions/$VID/extraction" | jq
#  { "status":"READY", "method":"pdf_native", "scannedClean":true,
#    "entities":[...], "tags":[{"tag":"fir",...}], ... }
```

**B. Scanned PDF / image → PaddleOCR**

```bash
curl -s -b $C -F file=@scanned.png \
  -F 'metadata={"title":"Scanned statement","docType":"WITNESS_STATEMENT","classification":"RESTRICTED"}' \
  http://localhost:3000/api/v1/cases/$CASE/documents | jq
# extraction.method == "ocr_paddle", extraction.ocrConfidence is a number
```

**C. DOCX / XLSX → native parsers** — upload a `.docx` / `.xlsx`, expect
`method` `docx` / `xlsx`.

**D. Infected file → QUARANTINED** (EICAR test string — harmless industry-standard):

```bash
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.txt
curl -s -b $C -F file=@eicar.txt \
  -F 'metadata={"title":"eicar","docType":"OTHER","classification":"RESTRICTED"}' \
  http://localhost:3000/api/v1/cases/$CASE/documents | jq
# after processing: processingStatus == "QUARANTINED"
curl -s -b $C ".../versions/$VID/extraction" | jq '{status,scannedClean,virusSignature}'
#  { "status":"QUARANTINED", "scannedClean":false, "virusSignature":"...Eicar..." }
# audit_log has a VERSION_PROCESSING_FAILED entry with details.reason == "quarantined"
# job is NOT retried
```

**E. Full-text search over extracted text**

```bash
curl -s -b $C "http://localhost:3000/api/v1/search?q=Amit%20Kumar" | jq '.results'
# the uploaded doc appears, matched on OCR/extracted text + entities
```

**F. Retry / fail path** — stop ClamAV mid-run and upload:

```bash
docker compose -f docker-compose.dev.yml stop clamav
# upload -> job retries 3x with backoff -> processingStatus "FAILED"
docker compose -f docker-compose.dev.yml start clamav
# within PROCESSING_RECONCILE_EVERY_MS the reconciler re-enqueues stuck rows
```

**G. Idempotency** — re-enqueue the same version (e.g. via reconcile) → no
duplicate `document_entities` rows, `document_extractions` updated in place.

### 7.3 Sidecar smoke tests

```bash
# ClamAV
docker compose -f docker-compose.dev.yml exec clamav clamdscan --version

# OCR
docker compose -f docker-compose.dev.yml exec ocr \
  python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8000/health').read())"
curl -F file=@scanned.png http://localhost:8000/ocr   # from host (port not published by default — add one, or exec)
```

### 7.4 DB assertions

```sql
SELECT v.processing_status, e.status, e.extraction_method, e.text_chars,
       e.ocr_confidence, e.scanned_clean, e.tags
FROM document_versions v JOIN document_extractions e ON e.version_id = v.id
WHERE v.id = '<VID>';

SELECT type, value, normalized_value, confidence, source
FROM document_entities WHERE version_id = '<VID>' ORDER BY start_offset;
```

---

## 8. API reference

All under `/api/v1`, all require auth (`requireAuth`). Fine-grained checks via
`authorize()`.

### Endpoints that **trigger** the pipeline

| Method | Path | Effect |
|--------|------|--------|
| `POST` | `/cases/:caseId/documents` | First version of a new document → enqueues processing (status starts `SCANNING`). |
| `POST` | `/documents/:id/versions` | New immutable version → enqueues processing. |
| `POST` | `/documents/:id/versions/:vid/restore` | Restored version (byte-identical copy) → re-scanned & re-processed. |

Request: multipart, field `file` (binary) + field `metadata` (JSON:
`title`, `docType`, `classification`, optional `description`, `tags`, `note`).

### Endpoints that **expose** results

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/documents/:id/versions/:vid/extraction` | **NEW.** The intelligence results (below). `?includeText=true` adds the raw extracted text. |
| `GET` | `/documents/:id/versions/:vid` | Version DTO — includes `processingStatus`. |
| `GET` | `/documents/:id` | Document DTO — includes `processingStatus`, `tags`. |
| `GET` | `/documents/:id/versions` | All versions with `processingStatus`. |
| `GET` | `/search?q=…&caseId=…&docType=…&classification=…&tags=…` | Full-text search — now matches `extractedText` + `entities` + `tags`. |

### `GET /documents/:id/versions/:vid/extraction` response

```jsonc
{
  "versionId": "…",
  "processingStatus": "READY",        // from document_versions
  "status": "READY",                  // from document_extractions (per-stage)
  "method": "pdf_native",             // pdf_native|ocr_paddle|docx|xlsx|plaintext|none
  "mimeType": "application/pdf",      // sniffed
  "textChars": 4210,
  "pageCount": 3,
  "ocrConfidence": null,              // number in [0,1] when method=ocr_paddle
  "scannedClean": true,
  "virusSignature": "…",              // only when QUARANTINED
  "error": "…",                       // only when FAILED
  "startedAt": "…", "finishedAt": "…",
  "tags": [{ "tag": "fir", "confidence": 0.95, "source": "rules" }],
  "entities": [
    { "type": "DATE", "value": "12/03/2026", "normalizedValue": "2026-03-12",
      "confidence": 0.82, "startOffset": 3, "endOffset": 13, "source": "regex" }
  ],
  "text": "…"                         // only with ?includeText=true (untrusted — escape in UI)
}
```

Before the worker has touched a version, `document_extractions` has no row yet —
the endpoint returns `{ status: <version.processingStatus>, method: null,
entities: [], tags: [] }`.

### Audit entries emitted

| Action | When | `details` |
|--------|------|-----------|
| `VERSION_PROCESSED` | pipeline reaches `READY` | `method`, `textChars`, `entitiesFound`, `tagsAdded` |
| `VERSION_PROCESSING_FAILED` | `QUARANTINED` or terminal `FAILED` | `reason` (`quarantined` / error string), `signature` |

---

## 9. Configuration reference

`config.processing.*` (env var → default):

| Env var | Default | Purpose |
|---------|---------|---------|
| `PROCESSING_ENABLED` | `true` | Master switch; `false` → uploads don't enqueue. |
| `PROCESSING_QUEUE_NAME` | `document-processing` | BullMQ queue name. |
| `PROCESSING_ATTEMPTS` | `3` | Retries per job (exponential backoff). |
| `PROCESSING_BACKOFF_MS` | `5000` | Backoff base. |
| `PROCESSING_CONCURRENCY` | `2` | Worker concurrency. |
| `PROCESSING_STUCK_AFTER_MS` | `900000` (15 min) | Non-terminal older than this → reconciled. |
| `PROCESSING_RECONCILE_EVERY_MS` | `300000` (5 min) | Reconcile sweep interval. |
| `PROCESSING_MAX_FILE_BYTES` | `UPLOAD_MAX_BYTES` / 50 MiB | Largest file the pipeline will read (stream cap). |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamav` / `3310` | clamd address. |
| `CLAMAV_TIMEOUT_MS` | `30000` | Socket timeout. |
| `OCR_URL` | `http://ocr:8000` | PaddleOCR sidecar. |
| `OCR_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `OCR_LANG` | `en` | PaddleOCR language. |
| `OCR_MIN_CHARS_PER_PAGE` | `100` | Below this native-text density, a PDF is treated as scanned. |
| `NER_PROVIDERS` | `regex` | Ordered, comma-separated provider ids. |
| `TAGGING_PIPELINE` | `rules` | Ordered, comma-separated tagger ids. |

---

## 10. Processing state machine

```
enqueue ─▶ SCANNING ──ClamAV──┬─ infected / disallowed type ─▶ QUARANTINED   (terminal, no retry)
                              │
                              └─ clean ─▶ EXTRACTING ─▶ INDEXING (NER) ─▶ TAGGING ─▶ READY

any stage throws (transient, e.g. clamd down, OCR timeout) ─▶ BullMQ retry (×3, exp backoff)
retries exhausted / non-quarantine UnrecoverableError       ─▶ FAILED  + VERSION_PROCESSING_FAILED
version stuck non-terminal > PROCESSING_STUCK_AFTER_MS      ─▶ reconciler re-enqueues (jobId dedupes)
```

`document_versions.processing_status` and `document_extractions.status` are kept
in lockstep. `READY` and `QUARANTINED` are terminal — a stale re-enqueue is a
no-op.

---

## 11. Failure handling, retries, stuck jobs

- **Fail-closed scan.** ClamAV unreachable or protocol error → the stage
  **throws**, the job retries. A file is never extracted/indexed without
  `scanned_clean = true`.
- **Infected → no retry.** `processing/clamav.js` returns `{clean:false}`; the
  processor writes `QUARANTINED` + `virus_signature` + audit, then throws
  `UnrecoverableError` so BullMQ doesn't retry. Bytes stay in storage (evidence
  is never auto-deleted — matches the existing version-immutability rule).
- **Disallowed real type** (magic-byte sniff fails the allow-list) → treated
  exactly like a detection (`QUARANTINED`, signature `Pipeline.DisallowedType.*`).
- **Transient stage error** (OCR timeout, DB blip) → normal `Error`, BullMQ
  retries ×`PROCESSING_ATTEMPTS`. On the last attempt `createProcessingFailureHandler`
  writes `FAILED` + `error` + audit.
- **Indexing is best-effort.** An OpenSearch outage logs and returns; it does
  **not** fail the job or flip a `READY` doc back. The reconciler / a future
  index sweep catches misses.
- **Stuck jobs.** `documentProcessing.reconcile.js` runs every
  `PROCESSING_RECONCILE_EVERY_MS`: `listStuckExtractions(cutoff)` → re-enqueue.
  `jobId = versionId` means a job that's actually still running is untouched.
- **Idempotency.** `document_extractions` upserts on `version_id`;
  `replaceEntities` deletes-then-inserts per version. A full re-run is safe.
- **Graceful shutdown.** `worker.js` clears the reconcile interval and
  `await`s `processingWorker.close()` on SIGINT/SIGTERM (in-flight jobs finish).

---

## 12. Extension points

### Add a custom NER entity type / smarter model

1. Write a provider object:
   ```js
   // src/processing/ner/spacyProvider.js
   export const spacyNerProvider = {
     id: "spacy",
     async extract(text) {
       // call your spaCy sidecar, return
       // [{ type, value, normalizedValue, confidence, startOffset, endOffset, source: "spacy" }]
     },
   };
   ```
2. Register it in `src/processing/ner/index.js` `DEFAULT_NER_REGISTRY`.
3. Enable + order it: `NER_PROVIDERS=regex,spacy` (later = higher trust in the merge).

No schema change — `document_entities.type` is free-form text.

### Add a classifier / LLM tagger

Same pattern: an object `{ id, async tag({text, entities, doc}) }`, registered in
`src/processing/tagging/index.js` `DEFAULT_TAGGER_REGISTRY`, enabled via
`TAGGING_PIPELINE=rules,classifier`.

### Add a new file format

Add a branch to `src/processing/extract/index.js#extractText` (lazy-`import()`
the parser) and, if its bytes have magic numbers, add the MIME to the allow-list
in `src/processing/clamav.js`.

---

## 13. Commit plan (block by block)

Each block builds cleanly and keeps `node --test` green. Suggested branch:
`feat/document-intelligence-pipeline`.

> `package-lock.json` changed with `package.json` — commit them together in the
> block that first needs the dep (Block 3), or all in Block 1. Keep them in the
> same commit.

**Block 1 — schema & migration**
```
git add src/db/schema/enums.js src/db/schema/documentIntelligence.js \
        src/db/schema/index.js drizzle/0003_document_intelligence.sql \
        drizzle/meta/_journal.json drizzle/meta/0003_snapshot.json
git commit -m "feat(db): document_extractions + document_entities tables, processing_status states"
```

**Block 2 — config & env**
```
git add src/config/index.js .env.example
git commit -m "feat(config): processing pipeline config block (clamav/ocr/ner/tagging)"
```

**Block 3 — queue + service wiring (enqueue after upload)**
```
git add package.json package-lock.json \
        src/jobs/documentProcessing.queue.js src/services/documents.service.js \
        src/repositories/documents.repo.js
git commit -m "feat(jobs): enqueue document-processing after upload; extraction repo helpers"
```

**Block 4 — processor state machine + worker + reconciler (pass-through stages)**
```
git add src/jobs/documentProcessing.processor.js \
        src/jobs/documentProcessing.reconcile.js src/worker.js \
        src/jobs/documentProcessing.processor.test.js
git commit -m "feat(worker): document-intelligence processor, failure handler, stuck-job reconciler"
```

**Block 5 — sidecar services**
```
git add docker-compose.dev.yml docker-compose.yml services/ocr/
git commit -m "feat(infra): clamav + paddleocr sidecar services"
```

**Block 6 — stage 1: ClamAV**
```
git add src/processing/clamav.js
git commit -m "feat(processing): ClamAV INSTREAM scanner + magic-byte type allow-list"
```

**Block 7 — stage 2: extraction**
```
git add src/processing/normalize.js src/processing/normalize.test.js \
        src/processing/ocr/paddleClient.js \
        src/processing/extract/index.js src/processing/extract/index.test.js
git commit -m "feat(processing): text extraction (pdf/docx/xlsx/plaintext) + PaddleOCR + normalization"
```

**Block 8 — stage 3: NER**
```
git add src/processing/ner/
git commit -m "feat(processing): regex NER provider + pluggable pipeline"
```

**Block 9 — stage 4: auto-tagging**
```
git add src/processing/tagging/
git commit -m "feat(processing): rule-based auto-tagger + pluggable pipeline"
```

**Block 10 — read API**
```
git add src/controllers/documents.controller.js src/routes/documents.route.js
# (services/documents.service.js already committed in Block 3 — if you want the
#  getVersionExtraction service fn in this commit instead, split Block 3.)
git commit -m "feat(api): GET /documents/:id/versions/:vid/extraction"
```

**Block 11 — docs**
```
git add docs/DOCUMENT_INTELLIGENCE.md
git commit -m "docs: document intelligence pipeline"
```

**Block 12 — test tooling & walkthrough**
```
git add scripts/dev-seed.mjs scripts/generate-ocr-samples.py \
        docs/TESTING_DOCUMENT_INTELLIGENCE.md .gitignore
git commit -m "test: dev fixture seeder, OCR sample generator, step-by-step testing guide"
```

> If you prefer strict "each commit fully works end-to-end", merge Blocks 4–10
> into one — the pass-through defaults in the processor mean Blocks 6–9 are
> incremental upgrades, each safe on its own.

---

## 14. Known limitations / TODO

- **`toVersionDTO` extraction summary** — not added; the dedicated
  `/extraction` endpoint covers it. Add a `{status, method, entityCount}` blob
  to the version DTO if the UI wants it inline.
- **OCR service port** — not published to the host in dev (internal only). Add a
  `ports: ["8001:8000"]` line temporarily for host-side smoke tests.
- **spaCy / LLM NER, classifier tagging** — seams are in place, providers not
  built.
- **Reindex/backfill** — `extracted_text` now lives in `document_extractions`,
  so a mapping change can be backfilled from Postgres (previously it only
  existed in-flight). A batch reindex command isn't written yet.
- **PII redaction** (DESIGN §11.5) — entities are located but not redacted.
- **Drizzle snapshot** `0003_snapshot.json` is a copy of `0002` (matches repo
  precedent). A later `npm run db:generate` will want to re-emit these tables;
  regenerate the snapshot properly at that point.
- **Docker e2e not yet run** in this environment — unit tests (25) pass;
  verify §7.2 on a machine with Docker.
```
