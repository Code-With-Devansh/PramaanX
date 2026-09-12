// Regex NER provider (pipeline stage 3, default). Deterministic, dependency-free
// entity extraction — the baseline the spaCy / LLM providers layer on top of
// later (they plug into the same registry in ./index.js).
//
// Every pattern here is linear / bounded (no nested quantifiers) so running it
// over attacker-controlled OCR text can't blow up. Input is length-capped by the
// pipeline before it reaches us.
//
// Entity shape: { type, value, normalizedValue, confidence, startOffset, endOffset, source }

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

// [regex, type, normalizer?, confidence?]. `normalizer(match)` -> string | null.
const PATTERNS = [
  // Email
  [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    "EMAIL",
    (m) => m[0].toLowerCase(),
    0.99,
  ],
  // URL
  [/\bhttps?:\/\/[^\s<>"')]+/gi, "URL", (m) => m[0].replace(/[.,;:]+$/, ""), 0.97],
  // Indian vehicle registration plate: MH 12 AB 1234 / MH-12-AB-1234
  [
    /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4}\b/g,
    "VEHICLE",
    (m) => m[0].replace(/[\s-]+/g, "-").toUpperCase(),
    0.9,
  ],
  // Legal section: "IPC §420", "IPC 420", "u/s 302 IPC", "BNS Section 103", "§ 66A IT Act"
  [
    /\b(?:IPC|BNS|BNSS|BSA|CrPC|CPC|IT Act)\s*(?:§|sec(?:tion)?\.?|u\/s)?\s*\d{1,4}[A-Z]?\b/gi,
    "LEGAL_SECTION",
    (m) => m[0].replace(/\s+/g, " ").replace(/\s*§\s*/, " §").trim().toUpperCase(),
    0.9,
  ],
  [
    /\bu\/s\s*\d{1,4}[A-Z]?\s*(?:of\s+)?(?:IPC|BNS|BNSS|CrPC)\b/gi,
    "LEGAL_SECTION",
    (m) => m[0].replace(/\s+/g, " ").toUpperCase(),
    0.88,
  ],
  // Case / FIR reference: "FIR-102", "FIR No. 102/2026", "Crime No 55/24"
  [
    /\b(?:FIR|Crime|Case|Chargesheet|CC|SC)\s*(?:No\.?|Number|#)?\s*[-:]?\s*\d{1,6}(?:\/\d{2,4})?\b/gi,
    "CASE_REF",
    (m) => m[0].replace(/\s+/g, " ").replace(/\s*[-:]\s*/, "-").toUpperCase(),
    0.85,
  ],
  // Money: "Rs. 5,00,000", "₹5000", "INR 1.2 crore", "USD 40,000", "$1,200.50"
  [
    /(?:₹|\$|Rs\.?|INR|USD)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|lakhs|crore|crores|k|million|billion))?/gi,
    "MONEY",
    (m) => m[0].replace(/\s+/g, " ").trim(),
    0.88,
  ],
  // Phone: Indian mobiles (optionally +91 and grouped with spaces/hyphens) and
  // landlines like "020-25501234".
  [
    /\+?91[\s-]?[6-9]\d{4}[\s-]?\d{5}\b|\b[6-9]\d{9}\b|\b0\d{2,4}[\s-]\d{6,8}\b/g,
    "PHONE",
    (m) => normalizePhone(m[0]),
    0.8,
  ],
  // Dates: 12/03/2026, 12-03-26, 2026-03-12, "12 March 2026", "March 12, 2026"
  [
    new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b`, "g"),
    "DATE",
    (m) => (isValidISO(m[0]) ? m[0] : null),
    0.9,
  ],
  [
    /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g,
    "DATE",
    (m) => normalizeDMY(m[1], m[2], m[3]),
    0.82,
  ],
  [
    new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\.?,?\\s+(\\d{4})\\b`, "gi"),
    "DATE",
    (m) => normalizeMonthName(m[3], m[2], m[1]),
    0.85,
  ],
  [
    new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"),
    "DATE",
    (m) => normalizeMonthName(m[3], m[1], m[2]),
    0.85,
  ],
];

// ── Heuristic PERSON / ORGANIZATION / LOCATION ──────────────────────────────
// No model here — just cue words. Low confidence so a real NER provider always
// wins the merge in ./index.js when one is configured.
const PERSON_CUE =
  /\b(?:Mr|Mrs|Ms|Dr|Shri|Smt|Sri|SI|ASI|PSI|HC|PC|Inspector|Sub-?Inspector|Constable|DySP|SP|DSP|ACP|DCP|Judge|Justice|Advocate|Adv)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;
const ORG_CUE =
  /\b([A-Z][A-Za-z&.]+(?:\s+[A-Z][A-Za-z&.]+){0,3})\s+(?:Police Station|Court|Hospital|Bank|Ltd|Limited|Pvt|Corporation|Department|Commission|Agency|Bureau)\b/g;
const LOCATION_CUE =
  /\b(?:at|near|in|from)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Road|Nagar|Colony|Chowk|Market|Marg|Street|Lane|Circle|Square|Village|District|Taluka)(?:,\s+[A-Z][A-Za-z]+)?)/g;

function pushCue(text, re, type, confidence, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[1]?.trim();
    if (!value) continue;
    const startOffset = m.index + m[0].indexOf(value);
    out.push({
      type,
      value,
      normalizedValue: null,
      confidence,
      startOffset,
      endOffset: startOffset + value.length,
      source: "regex",
    });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

export const regexNerProvider = {
  id: "regex",
  /**
   * @param {string} text
   * @returns {Promise<Array<object>>}
   */
  async extract(text) {
    if (!text) return [];
    const out = [];

    for (const [re, type, normalizer, confidence = 0.8] of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const raw = m[0];
        if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
        let normalizedValue = null;
        try {
          normalizedValue = normalizer ? normalizer(m) : null;
        } catch {
          normalizedValue = null;
        }
        // A DATE normalizer returning null means "reject this match" (e.g. 45/99).
        if (normalizer && normalizedValue === null && type === "DATE") continue;
        out.push({
          type,
          value: raw.trim(),
          normalizedValue: normalizedValue ?? null,
          confidence,
          startOffset: m.index,
          endOffset: m.index + raw.length,
          source: "regex",
        });
      }
    }

    pushCue(text, PERSON_CUE, "PERSON", 0.55, out);
    pushCue(text, ORG_CUE, "ORGANIZATION", 0.5, out);
    pushCue(text, LOCATION_CUE, "LOCATION", 0.5, out);

    return out;
  },
};

// ── normalizers ────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return null; // landline-ish; keep the raw value only
}

function isValidISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function normalizeDMY(d, m, y) {
  let day = Number(d);
  let month = Number(m);
  let year = Number(y);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  // Ambiguous MM/DD vs DD/MM: prefer DD/MM (Indian convention); swap if impossible.
  if (day > 31 || month > 12) return null;
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeMonthName(y, monthWord, d) {
  const month = MONTH_INDEX[monthWord.slice(0, 3).toLowerCase()];
  const day = Number(d);
  if (!month || day < 1 || day > 31) return null;
  return `${Number(y)}-${pad(month)}-${pad(day)}`;
}
