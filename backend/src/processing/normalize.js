// Text normalization (pipeline stage 2.5) -- the single funnel every extractor's
// output passes through before NER / tagging / indexing, so downstream stages
// never have to care whether the text came from pdf-parse, mammoth or OCR.
//
// Deliberately conservative: it fixes mechanical noise (encoding form, control
// chars, OCR line-wrap hyphenation, runaway whitespace) but does NOT lowercase,
// strip punctuation or reflow paragraphs -- NER needs the original casing and
// sentence structure.

// C0/C1 control chars, keeping only TAB (\x09) and LF (\x0A).
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
// Zero-width space / non-joiner / joiner / word-joiner / BOM.
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// Non-breaking and other exotic spaces -> plain space.
const EXOTIC_SPACE = /[   -   　]/g;
// A word split across a line break by hyphenation:
//   "inves-\ntigation" -> "investigation"   (­ is the soft hyphen)
const SOFT_HYPHEN_WRAP = /(\p{L})[-­]\n(\p{L})/gu;

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeText(raw) {
  if (!raw || typeof raw !== "string") return "";

  let text = raw.normalize("NFC");

  // Canonicalize newlines first so the hyphen-wrap and blank-line rules are simple.
  text = text.replace(/\r\n?/g, "\n");

  text = text.replace(SOFT_HYPHEN_WRAP, "$1$2");
  text = text.replace(ZERO_WIDTH, "");
  text = text.replace(EXOTIC_SPACE, " ");
  text = text.replace(CONTROL_CHARS, " ");

  // Collapse horizontal whitespace, trim line ends, cap blank runs at one.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

export default normalizeText;
