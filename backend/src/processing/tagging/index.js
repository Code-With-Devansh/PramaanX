// Auto-tagging pipeline (pipeline stage 4). Runs one or more taggers over the
// text + entities + document metadata and unions their suggestions, keeping the
// highest confidence per tag.
//
// Modular by design (user requirement): a rules tagger ships today; a trained
// classifier or an LLM tagger is added by registering another
// { id, async tag({ text, entities, doc }) -> Tag[] } here or via
// config.processing.taggingPipeline.

import { ruleTagger } from "./ruleTagger.js";

export const DEFAULT_TAGGER_REGISTRY = {
  [ruleTagger.id]: ruleTagger,
};

/**
 * @param {{
 *   stageIds?: string[],
 *   registry?: Record<string, { id: string, tag: (i: object) => Promise<Array<{ tag: string, confidence: number, source: string }>> }>,
 *   maxTags?: number,
 * }} opts
 */
export function createTagger({
  stageIds = ["rules"],
  registry = DEFAULT_TAGGER_REGISTRY,
  maxTags = 20,
} = {}) {
  const stages = stageIds.map((id) => registry[id]).filter(Boolean);

  if (!stages.length) {
    console.warn(`[tagging] no known taggers in [${stageIds.join(", ")}] — auto-tagging disabled`);
  }

  async function tag(input) {
    if (!stages.length) return [];

    const byTag = new Map();
    for (const stage of stages) {
      let suggestions = [];
      try {
        suggestions = (await stage.tag(input)) ?? [];
      } catch (err) {
        console.error(`[tagging] stage ${stage.id} failed:`, err?.message ?? err);
        continue;
      }
      for (const s of suggestions) {
        if (!s?.tag) continue;
        const existing = byTag.get(s.tag);
        if (!existing || (s.confidence ?? 0) > (existing.confidence ?? 0)) {
          byTag.set(s.tag, { tag: s.tag, confidence: s.confidence ?? 0.5, source: s.source ?? stage.id });
        }
      }
    }

    return [...byTag.values()]
      .sort((a, b) => b.confidence - a.confidence || a.tag.localeCompare(b.tag))
      .slice(0, maxTags);
  }

  return { tag, stageIds: stages.map((s) => s.id) };
}
