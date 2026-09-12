import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleTagger } from "./ruleTagger.js";
import { createTagger } from "./index.js";

test("tags from docType, entities and keywords", async () => {
  const tags = await ruleTagger.tag({
    text: "The accused was arrested and produced. Bail was denied; sent to judicial custody.",
    entities: [
      { type: "MONEY", value: "Rs. 5,00,000" },
      { type: "VEHICLE", value: "MH-12-AB-1234" },
      { type: "LEGAL_SECTION", value: "IPC §420", normalizedValue: "IPC §420" },
    ],
    doc: { docType: "FIR" },
  });
  const names = tags.map((t) => t.tag);

  assert.ok(names.includes("fir"));
  assert.ok(names.includes("financial"));
  assert.ok(names.includes("vehicle"));
  assert.ok(names.includes("ipc-420"));
  assert.ok(names.includes("arrest"));
  assert.ok(names.includes("bail"));
  assert.ok(names.includes("custody"));
  assert.ok(names.includes("accused"));
  for (const t of tags) {
    assert.equal(t.source, "rules");
    assert.ok(t.confidence > 0 && t.confidence <= 1);
  }
});

test("unknown docType is slugged; empty input yields no tags", async () => {
  assert.deepEqual(await ruleTagger.tag({ text: "", entities: [], doc: {} }), []);
  const t = await ruleTagger.tag({ doc: { docType: "SOME_NEW_TYPE" } });
  assert.deepEqual(t.map((x) => x.tag), ["some-new-type"]);
});

test("pipeline dedupes across stages, keeps highest confidence, caps count", async () => {
  const stageX = { id: "x", async tag() { return [{ tag: "bail", confidence: 0.4, source: "x" }]; } };
  const stageY = { id: "y", async tag() { return [{ tag: "bail", confidence: 0.9, source: "y" }, { tag: "extra", confidence: 0.5, source: "y" }]; } };
  const { tag } = createTagger({ stageIds: ["x", "y"], registry: { x: stageX, y: stageY }, maxTags: 5 });
  const out = await tag({});
  assert.equal(out.length, 2);
  assert.equal(out.find((t) => t.tag === "bail").confidence, 0.9);
});

test("default registry runs the rules tagger", async () => {
  const { tag, stageIds } = createTagger();
  assert.deepEqual(stageIds, ["rules"]);
  const out = await tag({ text: "warrant issued", entities: [], doc: { docType: "JUDGMENT" } });
  assert.ok(out.some((t) => t.tag === "judgment"));
  assert.ok(out.some((t) => t.tag === "warrant"));
});
