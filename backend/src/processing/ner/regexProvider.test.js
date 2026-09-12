import { test } from "node:test";
import assert from "node:assert/strict";
import { regexNerProvider } from "./regexProvider.js";

const SAMPLE =
  "On 12/03/2026, SI Rao arrested Amit Kumar near MG Road, Pune in connection with " +
  "FIR-102, vehicle MH-12-AB-1234, under IPC §420. Contact si.rao@police.gov.in or " +
  "+91 98765 43210. Seized cash Rs. 5,00,000.";

function byType(entities) {
  const m = {};
  for (const e of entities) (m[e.type] ??= []).push(e);
  return m;
}

test("extracts the DESIGN §11 sample entities", async () => {
  const m = byType(await regexNerProvider.extract(SAMPLE));

  assert.equal(m.DATE?.[0].normalizedValue, "2026-03-12");
  assert.ok(m.CASE_REF?.some((e) => e.normalizedValue === "FIR-102"));
  assert.ok(m.VEHICLE?.some((e) => e.normalizedValue === "MH-12-AB-1234"));
  assert.ok(m.LEGAL_SECTION?.some((e) => /IPC §420/i.test(e.value)));
  assert.ok(m.EMAIL?.some((e) => e.normalizedValue === "si.rao@police.gov.in"));
  assert.ok(m.PHONE?.some((e) => e.normalizedValue === "+919876543210"));
  assert.ok(m.MONEY?.some((e) => /5,00,000/.test(e.value)));
  assert.ok(m.PERSON?.some((e) => e.value === "Rao"));
  assert.ok(m.LOCATION?.some((e) => /MG Road/.test(e.value)));
});

test("every entity carries a span and source", async () => {
  const entities = await regexNerProvider.extract(SAMPLE);
  for (const e of entities) {
    assert.equal(e.source, "regex");
    assert.equal(SAMPLE.slice(e.startOffset, e.endOffset), e.value);
    assert.ok(e.confidence > 0 && e.confidence <= 1);
  }
});

test("rejects impossible dates", async () => {
  const m = byType(await regexNerProvider.extract("filed on 45/99/2026 supposedly"));
  assert.ok(!m.DATE);
});

test("empty / missing text -> []", async () => {
  assert.deepEqual(await regexNerProvider.extract(""), []);
  assert.deepEqual(await regexNerProvider.extract(null), []);
});
