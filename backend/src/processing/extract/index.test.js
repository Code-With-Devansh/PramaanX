import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtractor } from "./index.js";

function fakeOcr() {
  const calls = [];
  const ocrClient = {
    ocr: async (input) => {
      calls.push(input);
      return { text: "OCR TEXT", confidence: 0.87, pageCount: 2 };
    },
  };
  return { ocrClient, calls };
}

test("plain text is decoded natively", async () => {
  const { ocrClient, calls } = fakeOcr();
  const { extractText } = createExtractor({ ocrClient });
  const out = await extractText({
    buffer: Buffer.from("hello, world"),
    mimeType: "text/plain",
    fileName: "note.txt",
  });
  assert.equal(out.method, "plaintext");
  assert.equal(out.text, "hello, world");
  assert.equal(calls.length, 0);
});

test("images go straight to OCR", async () => {
  const { ocrClient, calls } = fakeOcr();
  const { extractText } = createExtractor({ ocrClient });
  const out = await extractText({
    buffer: Buffer.from("\x89PNG"),
    mimeType: "image/png",
    fileName: "scan.png",
  });
  assert.equal(out.method, "ocr_paddle");
  assert.equal(out.text, "OCR TEXT");
  assert.equal(out.confidence, 0.87);
  assert.equal(calls.length, 1);
});

test("dispatch falls back to filename extension when mime is generic", async () => {
  const { ocrClient, calls } = fakeOcr();
  const { extractText } = createExtractor({ ocrClient });
  const out = await extractText({
    buffer: Buffer.from("x"),
    mimeType: "application/octet-stream",
    fileName: "photo.jpeg",
  });
  assert.equal(out.method, "ocr_paddle");
  assert.equal(calls.length, 1);
});

test("unknown type yields an empty 'none' result (NER/tagging no-op downstream)", async () => {
  const { ocrClient } = fakeOcr();
  const { extractText } = createExtractor({ ocrClient });
  const out = await extractText({
    buffer: Buffer.from("x"),
    mimeType: "application/x-mystery",
    fileName: "thing.bin",
  });
  assert.deepEqual(out, { text: "", method: "none", confidence: null, pageCount: null, mimeType: "application/x-mystery" });
});
