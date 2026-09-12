// NER pipeline (pipeline stage 3). Runs one or more providers over the extracted
// text and merges their output into a single de-duplicated entity list.
//
// Adding a custom entity type or a smarter model later = ship a new provider
// object ({ id, async extract(text) -> Entity[] }) and register it here / via
// config.processing.nerProviders — no change to the processor or the schema
// (document_entities.type is free-form TEXT).

import { regexNerProvider } from "./regexProvider.js";

// id -> provider. Only the regex baseline ships today.
export const DEFAULT_NER_REGISTRY = {
  [regexNerProvider.id]: regexNerProvider,
};

// Two mentions are "the same" when they're the same type at the same span, or
// the same type with the same canonical value. Later providers (higher trust)
// override earlier ones on the value key; span key keeps the best confidence.
function dedupeKey(e) {
  const canon = (e.normalizedValue ?? e.value ?? "").toLowerCase().trim();
  return `${e.type}::${canon}`;
}

/**
 * @param {{
 *   providerIds?: string[],
 *   registry?: Record<string, { id: string, extract: (t: string) => Promise<Array<object>> }>,
 * }} opts
 */
export function createNerPipeline({ providerIds = ["regex"], registry = DEFAULT_NER_REGISTRY } = {}) {
  const providers = providerIds
    .map((id) => registry[id])
    .filter(Boolean);

  if (!providers.length) {
    console.warn(`[ner] no known providers in [${providerIds.join(", ")}] — NER disabled`);
  }

  async function extract(text) {
    if (!text || !providers.length) return [];

    const byKey = new Map();
    // Providers run in listed order; a later one is treated as more authoritative.
    for (const provider of providers) {
      let found = [];
      try {
        found = (await provider.extract(text)) ?? [];
      } catch (err) {
        console.error(`[ner] provider ${provider.id} failed:`, err?.message ?? err);
        continue;
      }
      for (const e of found) {
        if (!e?.type || !e?.value) continue;
        const key = dedupeKey(e);
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, { ...e, source: e.source ?? provider.id });
        } else if (provider !== providers[0] || (e.confidence ?? 0) > (existing.confidence ?? 0)) {
          // higher-trust provider, or same provider with a better hit
          byKey.set(key, {
            ...existing,
            ...e,
            confidence: Math.max(e.confidence ?? 0, existing.confidence ?? 0),
            source: e.source ?? provider.id,
          });
        }
      }
    }

    return [...byKey.values()].sort(
      (a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0) || a.type.localeCompare(b.type),
    );
  }

  return { extract, providerIds: providers.map((p) => p.id) };
}
