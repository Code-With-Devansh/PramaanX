# Testing the Document Intelligence Pipeline — Step by Step

A hands-on walkthrough: stand the stack up, get an auth token without the full
login/MFA flow, upload a **safe file**, a **virus-like demo file** (the
industry-standard EICAR test string — 100% harmless, not executable, every
antivirus engine is deliberately configured to flag it), and a **scanned
document** (forces OCR) — then read back the results at every stage.

Companion doc: [DOCUMENT_INTELLIGENCE.md](DOCUMENT_INTELLIGENCE.md) (architecture,
file-by-file reference, API reference, commit plan). This doc is the "how do I
actually click the buttons" companion to that one.

- [0. What EICAR actually is](#0-what-eicar-actually-is)
- [1. Start the stack](#1-start-the-stack)
- [2. Get a test identity + auth token](#2-get-a-test-identity--auth-token)
- [3. Generate the test files](#3-generate-the-test-files)
- [4. Test A — safe file (native text + NER + tagging)](#4-test-a--safe-file-native-text--ner--tagging)
- [5. Test B — the "virus" demo file (EICAR → quarantine)](#5-test-b--the-virus-demo-file-eicar--quarantine)
- [6. Test C — OCR (scanned image / scanned PDF)](#6-test-c--ocr-scanned-image--scanned-pdf)
- [7. Test D — DOCX / XLSX (native parsers)](#7-test-d--docx--xlsx-native-parsers)
- [8. Test E — full-text search over extracted text](#8-test-e--full-text-search-over-extracted-text)
- [9. Test F — failure / retry / stuck-job reconciliation](#9-test-f--failure--retry--stuck-job-reconciliation)
- [10. Unit tests (no Docker needed)](#10-unit-tests-no-docker-needed)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Cleanup](#12-cleanup)

---

## 0. What EICAR actually is

The [EICAR test file](https://www.eicar.org/download-anti-malware-testfile/) is
a **68-byte plain-text string** that every antivirus vendor (ClamAV included)
hard-codes a detection rule for, specifically so people can test AV pipelines
without handling real malware:

```
X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*
```

- It is **not executable code** and does nothing if opened, run, or catted.
- It contains no exploit, no payload, no macro — just that ASCII string.
- ClamAV reports it as signature `Eicar-Test-Signature` (or similar) — this is
  what you'll see in `document_extractions.virus_signature`.

We use it below as the "demo file that looks like a virus to the scanner" —
exactly what it's designed for. It's gitignored in this repo
(`test/fixtures/document-intelligence/`) so it never ships in a commit — some
scanners/mirrors flag the pattern on sight even though it's inert.

---

## 1. Start the stack

```bash
cd /path/to/pramaanX
cp .env.example .env   # if you don't already have one; fill in secrets as needed
npm run dev
```

Wait for everything to come up (first run builds the PaddleOCR image and
downloads ClamAV signatures — a few minutes):

```bash
docker compose -f docker-compose.dev.yml ps
#  clamav   ... healthy
#  ocr      ... healthy (or "running" if no port published)
#  opensearch ... healthy
#  worker   ... running

docker compose -f docker-compose.dev.yml logs worker --tail 20
#  [ledger] worker up on queue ledger-anchor ...
#  [processing] worker up on queue document-processing (concurrency=2, enabled=true)
```

Apply the migration if you haven't already (the `migrate` service in compose
does this automatically on `npm run dev`, but if you're iterating):

```bash
docker compose -f docker-compose.dev.yml exec api npm run migrate
```

---

## 2. Get a test identity + auth token

Every document route requires `Authorization: Bearer <access token>`, and a
real token needs a real user row (org, jurisdiction, clearance, etc.) — the
full provisioning/login/MFA flow is unrelated to this feature. Use the
provided seed script instead: it creates a demo org/jurisdiction/user/case and
mints a real, working access token the same way `/auth/login` would.

```bash
docker compose -f docker-compose.dev.yml exec api node scripts/dev-seed.mjs
```

Output looks like:

```
=== document-intelligence test fixtures ready ===
user: 3f2c...  (demo.investigator)
case: 9a11...  (DEMO-CASE-0001)

access token (expires with JWT_ACCESS_EXPIRES, default 15m -- rerun this script for a fresh one):
eyJhbGciOi...

copy/paste on the HOST shell you run curl from:
  export TOKEN="eyJhbGciOi..."
  export CASE="9a11..."
  export API=http://localhost:3000/api/v1
```

Paste those three `export` lines into the terminal you'll run `curl`/`jq` from
(the host, not the container — port 3000 is published). The script is
**idempotent** — rerun it any time your token expires (default 15 min) to mint
a fresh one against the same demo user/case.

> `jq` is used throughout below for readability (`apt install jq` /
> `brew install jq` if you don't have it) — every command also works without it,
> just drop the `| jq ...` and read the raw JSON.

---

## 3. Generate the test files

```bash
mkdir -p test/fixtures/document-intelligence

# A) the EICAR "virus-like" demo file (see §0) -- exactly the 68-byte standard string
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > test/fixtures/document-intelligence/eicar-test-file.txt

# B) a safe plaintext file with rich entities (dates, phone, email, money,
#    vehicle plate, legal sections, FIR ref) to exercise NER + auto-tagging
cat > test/fixtures/document-intelligence/safe-sample.txt <<'EOF'
FIRST INFORMATION REPORT

FIR No. 102/2026
Police Station: MG Road Police Station, Pune
Date of Registration: 12/03/2026

On 12 March 2026, SI Rao arrested Amit Kumar near MG Road, Pune in connection
with FIR-102, vehicle MH-12-AB-1234, under IPC Section 420 and IPC Section 34.

Complainant contact: si.rao@police.gov.in, phone +91 98765 43210.
Seized property: cash amounting to Rs. 5,00,000 recovered from the accused.

The accused was produced before the magistrate. Bail was denied and the
accused was sent to judicial custody for 14 days pending further
investigation. A forensic report and post-mortem examination have been
requested from the FSL. Witness statements were recorded on 13/03/2026.

Investigating Officer: SI Rao, MG Road Police Station, Pune.
EOF

# C) a "scanned document" -- a PNG and a rasterized PDF with NO embedded text
#    layer, so they force the OCR path (requires only Pillow: pip install pillow)
python3 scripts/generate-ocr-samples.py test/fixtures/document-intelligence
#  wrote test/fixtures/document-intelligence/scanned-sample.png
#  wrote test/fixtures/document-intelligence/scanned-sample.pdf
```

You now have, all under `test/fixtures/document-intelligence/` (gitignored):

| File | Purpose |
|------|---------|
| `safe-sample.txt` | clean file → full pipeline → `READY` |
| `eicar-test-file.txt` | ClamAV-detected → `QUARANTINED` |
| `scanned-sample.png` | image → forces PaddleOCR |
| `scanned-sample.pdf` | rasterized PDF, ~0 native text → OCR fallback |

---

## 4. Test A — safe file (native text + NER + tagging)

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@test/fixtures/document-intelligence/safe-sample.txt \
  -F 'metadata={"title":"Safe sample FIR","docType":"FIR","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | tee /tmp/doc.json | jq

DOC=$(jq -r .id /tmp/doc.json)
VID=$(jq -r .currentVersionId /tmp/doc.json)
echo "DOC=$DOC  VID=$VID"
```

Poll processing status until it reaches `READY` (a few seconds — no OCR needed):

```bash
watch -n1 "curl -s -H \"Authorization: Bearer \$TOKEN\" \"\$API/documents/\$DOC/versions/\$VID\" | jq .processingStatus"
#  "SCANNING" -> "EXTRACTING" -> "INDEXING" -> "TAGGING" -> "READY"
```

Read the intelligence results:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/documents/$DOC/versions/$VID/extraction" | jq
```

**Expected** (this exact fixture, verified against the real pipeline code):

```jsonc
{
  "status": "READY",
  "method": "plaintext",
  "scannedClean": true,
  "textChars": 830,          // approx
  "tags": [
    { "tag": "fir", "confidence": 0.95, "source": "rules" },
    { "tag": "ipc-section-420", "confidence": 0.8, "source": "rules" },
    { "tag": "ipc-section-34", "confidence": 0.8, "source": "rules" },
    { "tag": "financial", "confidence": 0.7, "source": "rules" },
    { "tag": "vehicle", "confidence": 0.7, "source": "rules" },
    { "tag": "contact-info", "confidence": 0.7, "source": "rules" },
    { "tag": "arrest", "confidence": 0.6, "source": "rules" },
    { "tag": "bail", "confidence": 0.6, "source": "rules" },
    { "tag": "custody", "confidence": 0.6, "source": "rules" },
    { "tag": "accused", "confidence": 0.6, "source": "rules" },
    { "tag": "forensic", "confidence": 0.6, "source": "rules" },
    { "tag": "post-mortem", "confidence": 0.6, "source": "rules" },
    { "tag": "seizure", "confidence": 0.6, "source": "rules" },
    { "tag": "witness", "confidence": 0.6, "source": "rules" }
  ],
  "entities": [
    { "type": "CASE_REF", "value": "FIR No. 102/2026", "normalizedValue": "FIR NO. 102/2026" },
    { "type": "ORGANIZATION", "value": "MG Road" },
    { "type": "DATE", "value": "12 March 2026", "normalizedValue": "2026-03-12" },
    { "type": "PERSON", "value": "Rao" },
    { "type": "LOCATION", "value": "MG Road, Pune" },
    { "type": "CASE_REF", "value": "FIR-102", "normalizedValue": "FIR-102" },
    { "type": "VEHICLE", "value": "MH-12-AB-1234", "normalizedValue": "MH-12-AB-1234" },
    { "type": "LEGAL_SECTION", "value": "IPC Section 420" },
    { "type": "LEGAL_SECTION", "value": "IPC Section 34" },
    { "type": "EMAIL", "value": "si.rao@police.gov.in" },
    { "type": "PHONE", "value": "+91 98765 43210", "normalizedValue": "+919876543210" },
    { "type": "MONEY", "value": "Rs. 5,00,000" },
    { "type": "DATE", "value": "13/03/2026", "normalizedValue": "2026-03-13" }
  ]
}
```

> `ORGANIZATION: "MG Road"` is a heuristic false-positive from the cue "MG Road
> **Police Station**" — expected behavior of the low-confidence regex
> PERSON/ORG/LOCATION heuristics (see [DOCUMENT_INTELLIGENCE.md §12](DOCUMENT_INTELLIGENCE.md#12-extension-points)
> for swapping in a real NER model).

Confirm the plain tags landed on the document too:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$API/documents/$DOC" | jq .tags
```

---

## 5. Test B — the "virus" demo file (EICAR → quarantine)

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@test/fixtures/document-intelligence/eicar-test-file.txt \
  -F 'metadata={"title":"eicar demo","docType":"OTHER","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | tee /tmp/doc2.json | jq

DOC2=$(jq -r .id /tmp/doc2.json)
VID2=$(jq -r .currentVersionId /tmp/doc2.json)
```

Poll it:

```bash
watch -n1 "curl -s -H \"Authorization: Bearer \$TOKEN\" \"\$API/documents/\$DOC2/versions/\$VID2\" | jq .processingStatus"
#  "SCANNING" -> "QUARANTINED"   (terminal -- no EXTRACTING/INDEXING/TAGGING, no retry)
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/documents/$DOC2/versions/$VID2/extraction" | jq
```

**Expected:**

```jsonc
{
  "status": "QUARANTINED",
  "method": null,
  "scannedClean": false,
  "virusSignature": "Eicar-Test-Signature",   // or similar -- ClamAV's own name for it
  "entities": [],
  "tags": []
}
```

Confirm it in the worker logs and the audit trail:

```bash
docker compose -f docker-compose.dev.yml logs worker --tail 20 | grep -i quarant
#  [processing] failed for <VID2> (attempt 1/3) — terminal: virus scan flagged version ...

curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/audit?targetId=$VID2" | jq '.items[] | {action, details}'
#  action: "VERSION_PROCESSING_FAILED", details.reason: "quarantined", details.signature: "Eicar-Test-Signature"
```

Also verify **it did not retry** — `attemptsMade` stays at 1, unlike a
transient failure which would go to 3.

---

## 6. Test C — OCR (scanned image / scanned PDF)

```bash
# image -- always goes straight to OCR, no scanned-vs-text heuristic needed
curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@test/fixtures/document-intelligence/scanned-sample.png \
  -F 'metadata={"title":"scanned image demo","docType":"WITNESS_STATEMENT","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | tee /tmp/doc3.json | jq
DOC3=$(jq -r .id /tmp/doc3.json); VID3=$(jq -r .currentVersionId /tmp/doc3.json)
```

This one takes longer the **first** time (PaddleOCR downloads its models on
first use inside the `ocr` container — watch `docker compose logs -f ocr`).
Poll until `READY`, then:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/documents/$DOC3/versions/$VID3/extraction" | jq '{status, method, ocrConfidence, textChars}'
#  { "status": "READY", "method": "ocr_paddle", "ocrConfidence": 0.9x, "textChars": ~250 }

curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/documents/$DOC3/versions/$VID3/extraction?includeText=true" | jq -r .text
#  should read back the "FIR No. 102/2026 ... SI Rao ... MH-12-AB-1234 ..." text
#  we drew onto the image, with the usual OCR noise (a stray character or two).
```

Repeat with `scanned-sample.pdf` (same `metadata`, different `-F file=@...`) —
expect `method: "ocr_paddle"` again (pdf-parse sees ~0 native chars/page on a
purely rasterized PDF, so the processor falls back to OCR automatically) and a
`pageCount` of 1.

---

## 7. Test D — DOCX / XLSX (native parsers)

Use any `.docx` / `.xlsx` you have handy (or `libreoffice --headless --convert-to docx safe-sample.txt` if you want one generated locally):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@/path/to/sample.docx \
  -F 'metadata={"title":"docx demo","docType":"OTHER","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | jq
# ... poll ... extraction.method == "docx"

curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@/path/to/sample.xlsx \
  -F 'metadata={"title":"xlsx demo","docType":"OTHER","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | jq
# ... poll ... extraction.method == "xlsx"
```

---

## 8. Test E — full-text search over extracted text

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/search?q=Amit%20Kumar" | jq '.results'
# Test A's document appears, matched on the extracted text / entities

curl -s -H "Authorization: Bearer $TOKEN" \
  "$API/search?q=custody&caseId=$CASE" | jq '.results'
```

---

## 9. Test F — failure / retry / stuck-job reconciliation

**Transient failure → retries → FAILED:**

```bash
docker compose -f docker-compose.dev.yml stop clamav

curl -s -H "Authorization: Bearer $TOKEN" \
  -F file=@test/fixtures/document-intelligence/safe-sample.txt \
  -F 'metadata={"title":"retry demo","docType":"OTHER","classification":"RESTRICTED"}' \
  "$API/cases/$CASE/documents" | jq
DOC4=$(jq -r .id /tmp/doc.json); VID4=$(jq -r .currentVersionId /tmp/doc.json)  # reuse last response or re-tee

docker compose -f docker-compose.dev.yml logs -f worker
#  [processing] failed for <VID4> (attempt 1/3) — will retry: clamd timeout / ECONNREFUSED
#  [processing] failed for <VID4> (attempt 2/3) — will retry: ...
#  [processing] failed for <VID4> (attempt 3/3) — terminal: ...

curl -s -H "Authorization: Bearer $TOKEN" "$API/documents/$DOC4/versions/$VID4" | jq .processingStatus
#  "FAILED"
```

**Reconciler picks it back up once ClamAV is healthy again:**

```bash
docker compose -f docker-compose.dev.yml start clamav
# wait for it to report healthy, then wait up to PROCESSING_RECONCILE_EVERY_MS (default 5 min)
docker compose -f docker-compose.dev.yml logs -f worker | grep reconcile
#  [processing] reconcile re-enqueued 1 stuck version(s)
```

(To see this faster in dev, temporarily set `PROCESSING_RECONCILE_EVERY_MS=30000`
in `.env` and restart the worker.)

---

## 10. Unit tests (no Docker needed)

The per-module logic (state machine, extraction dispatch, NER, tagging,
normalization) is covered without any infra:

```bash
node --test \
  src/jobs/documentProcessing.processor.test.js \
  src/processing/normalize.test.js \
  src/processing/extract/index.test.js \
  src/processing/ner/regexProvider.test.js \
  src/processing/ner/index.test.js \
  src/processing/tagging/ruleTagger.test.js
# 25 pass
```

Run these after any change to `src/jobs/documentProcessing.processor.js` or
anything under `src/processing/` — they run in under a second and don't need
`npm run dev` at all.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` on every request | token expired (15 min default) or you forgot to `export TOKEN=...` | rerun `scripts/dev-seed.mjs` |
| `403 Forbidden` on upload | wrong `$CASE`, or you're not using the token from the last `dev-seed.mjs` run | re-export the printed `TOKEN`/`CASE` |
| stuck on `SCANNING` forever | `clamav` container not healthy yet | `docker compose ps`; wait for `clamav` healthy (first-boot signature download can take ~2 min) |
| stuck on `EXTRACTING` for scanned files | `ocr` container still downloading PaddleOCR models (first call only) | `docker compose logs -f ocr` |
| `document_extractions` has no row | worker never picked up the job — check `PROCESSING_ENABLED=true` and that `worker` is running and connected to the same Redis as `api` | `docker compose logs worker`; check `REDIS_URL` matches on both services |
| EICAR upload doesn't quarantine | ClamAV signatures didn't finish downloading, or you saved the string with different bytes (must be the exact 68-byte EICAR string, no CRLF/trailing content added) | `wc -c test/fixtures/document-intelligence/eicar-test-file.txt` → must print `68`; `docker compose exec clamav clamdscan --version` |
| `scripts/generate-ocr-samples.py` errors on font | no truetype font found on the host | install `fonts-dejavu` (`apt install fonts-dejavu-core`) or edit `FONT_CANDIDATES` in the script to point at any `.ttf` you have |
| `scripts/dev-seed.mjs` fails with a unique-constraint error | ran before a previous partial run committed inconsistent rows | the script is idempotent by design (`ON CONFLICT DO NOTHING` + re-select) — rerunning is safe; if it still fails, `docker compose exec postgres psql -U postgres -d pramaanX` and inspect `orgs`/`jurisdictions`/`users`/`cases` for the demo rows |

---

## 12. Cleanup

```bash
rm -rf test/fixtures/document-intelligence     # regenerate any time with §3
docker compose -f docker-compose.dev.yml down -v   # wipes all volumes, including clamav/ocr caches
```

The demo user/case created by `scripts/dev-seed.mjs` live in Postgres like any
other row — delete them by hand if you want a clean database, or just leave
them (they're inert and clearly labeled `Demo PD` / `DEMO-CASE-0001`).
