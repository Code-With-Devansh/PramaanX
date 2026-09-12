import { test } from "node:test";
import assert from "node:assert/strict";
import { createNerPipeline } from "./index.js";

const provA = {
  id: "a",
  async extract() {
    return [
      { type: "PERSON", value: "Amit Kumar", confidence: 0.5, startOffset: 0, endOffset: 10, source: "a" },
      { type: "EMAIL", value: "X@Y.COM", normalizedValue: "x@y.com", confidence: 0.9, startOffset: 20, endOffset: 27, source: "a" },
    ];
  },
};
const provB = {
  id: "b",
  async extract() {
    // higher-trust duplicate of the PERSON, plus a new entity
    return [
      { type: "PERSON", value: "Amit Kumar", confidence: 0.95, startOffset: 0, endOffset: 10, source: "b" },
      { type: "LOCATION", value: "Pune", confidence: 0.8, startOffset: 40, endOffset: 44, source: "b" },
    ];
  },
};

test("merges providers, dedupes by type+canonical value, keeps the better hit", async () => {
  const { extract } = createNerPipeline({ providerIds: ["a", "b"], registry: { a: provA, b: provB } });
  const out = await extract("irrelevant");

  const person = out.filter((e) => e.type === "PERSON");
  assert.equal(person.length, 1);
  assert.equal(person[0].confidence, 0.95);
  assert.equal(person[0].source, "b");
  assert.equal(out.length, 3); // PERSON (merged), EMAIL, LOCATION
  // sorted by startOffset
  assert.deepEqual(out.map((e) => e.type), ["PERSON", "EMAIL", "LOCATION"]);
});

test("a throwing provider is skipped, not fatal", async () => {
  const bad = { id: "bad", async extract() { throw new Error("boom"); } };
  const { extract } = createNerPipeline({ providerIds: ["bad", "a"], registry: { bad, a: provA } });
  const out = await extract("x");
  assert.equal(out.length, 2);
});

test("unknown provider ids => empty pipeline => []", async () => {
  const { extract, providerIds } = createNerPipeline({ providerIds: ["nope"], registry: {} });
  assert.deepEqual(providerIds, []);
  assert.deepEqual(await extract("anything"), []);
});

test("default registry wires the regex provider", async () => {
  const { extract } = createNerPipeline();
  const out = await extract("call +91 98765 43210 today");
  assert.ok(out.some((e) => e.type === "PHONE" && e.normalizedValue === "+919876543210"));
});
