// Rule-based auto-tagger (pipeline stage 4, default). Three cheap signals:
// document type, entity presence, and a keyword lexicon. A classifier or LLM
// tagger plugs into the same registry (./index.js) later without touching the
// processor.
//
// Tag shape: { tag, confidence, source }. Tags are lowercase, hyphenated slugs.

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// docType enum value -> a friendlier tag (falls back to the slugged enum).
const DOC_TYPE_TAG = {
  FIR: "fir",
  POLICE_REPORT: "police-report",
  INVESTIGATION_RECORD: "investigation",
  WITNESS_STATEMENT: "witness-statement",
  CHARGE_SHEET: "chargesheet",
  COURT_FILING: "court-filing",
  EVIDENCE_RECORD: "evidence",
  FORENSIC_REPORT: "forensic",
  LEGAL_NOTICE: "legal-notice",
  JUDGMENT: "judgment",
};

// keyword (word-boundary, case-insensitive) -> tag.
const KEYWORD_TAGS = [
  [/\bbail\b/i, "bail"],
  [/\b(?:police custody|judicial custody|remand)\b/i, "custody"],
  [/\barrest(?:ed|s)?\b/i, "arrest"],
  [/\b(?:post-?mortem|autopsy)\b/i, "post-mortem"],
  [/\b(?:seizure|seized|recovered)\b/i, "seizure"],
  [/\bwarrant\b/i, "warrant"],
  [/\bwitness(?:es)?\b/i, "witness"],
  [/\b(?:forensic|FSL|DNA|ballistic|fingerprint)\b/i, "forensic"],
  [/\b(?:accused|suspect)\b/i, "accused"],
  [/\b(?:chargesheet|charge sheet|final report)\b/i, "chargesheet"],
  [/\b(?:summons|notice under section)\b/i, "summons"],
  [/\bconfession(?:al)?\b/i, "confession"],
];

// entity type -> a tag it implies (plus per-value tags handled inline below).
const ENTITY_TYPE_TAGS = {
  MONEY: "financial",
  VEHICLE: "vehicle",
  PHONE: "contact-info",
  EMAIL: "contact-info",
};

export const ruleTagger = {
  id: "rules",
  /**
   * @param {{ text?: string, entities?: Array<{type: string, normalizedValue?: string, value?: string}>, doc?: { docType?: string } }} input
   * @returns {Promise<Array<{ tag: string, confidence: number, source: string }>>}
   */
  async tag({ text = "", entities = [], doc = {} } = {}) {
    const tags = [];
    const add = (tag, confidence) => tag && tags.push({ tag, confidence, source: "rules" });

    if (doc.docType) add(DOC_TYPE_TAG[doc.docType] ?? slug(doc.docType), 0.95);

    const seenTypes = new Set();
    for (const e of entities) {
      if (ENTITY_TYPE_TAGS[e.type] && !seenTypes.has(e.type)) {
        seenTypes.add(e.type);
        add(ENTITY_TYPE_TAGS[e.type], 0.7);
      }
      if (e.type === "LEGAL_SECTION") {
        // "IPC §420" -> "ipc-420"
        add(slug(e.normalizedValue ?? e.value), 0.8);
      }
    }

    if (text) {
      for (const [re, tag] of KEYWORD_TAGS) {
        if (re.test(text)) add(tag, 0.6);
      }
    }

    return tags;
  },
};
