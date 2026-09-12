// MIME-type -> processing-category map for the document-processing pipeline
// (DESIGN §11). Not every upload needs OCR: a native PDF or a Word doc already
// has a text layer, a .txt/.csv is text already, and some uploads (zip,
// unknown binaries) can't be extracted at all. documentProcessing.processor.js
// uses this to pick which extraction stub to call during the OCR stage — the
// extraction functions themselves stay mocked, only the routing is real here.

export const FileCategory = {
  IMAGE: "IMAGE", // scanned page / photo — needs real OCR
  PDF: "PDF", // may be a native text-layer PDF or a scanned one — handled inside extractPdfText
  WORD: "WORD", // .doc/.docx — text layer extraction, no OCR
  TEXT: "TEXT", // .txt/.csv/.md — already plain text, no extraction step really needed
  UNSUPPORTED: "UNSUPPORTED", // no extraction path yet (e.g. spreadsheets, archives, audio/video)
};

const MIME_CATEGORY_MAP = {
  "application/pdf": FileCategory.PDF,

  "image/png": FileCategory.IMAGE,
  "image/jpeg": FileCategory.IMAGE,
  "image/jpg": FileCategory.IMAGE,
  "image/tiff": FileCategory.IMAGE,
  "image/bmp": FileCategory.IMAGE,
  "image/webp": FileCategory.IMAGE,
  "image/gif": FileCategory.IMAGE,

  "application/msword": FileCategory.WORD,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": FileCategory.WORD,

  "text/plain": FileCategory.TEXT,
  "text/csv": FileCategory.TEXT,
  "text/markdown": FileCategory.TEXT,
};

/**
 * Classify a MIME type into a processing category. Unknown/unsupported types
 * (spreadsheets, archives, audio/video, etc.) fall back to UNSUPPORTED rather
 * than throwing — an upload of a type we can't extract text from should still
 * go through virus-scan and land in the index (title/tags/description
 * searchable, extractedText empty), not fail the whole job.
 *
 * @param {string} mimeType
 * @returns {string} one of FileCategory
 */
export function classifyFile(mimeType) {
  return MIME_CATEGORY_MAP[mimeType] ?? FileCategory.UNSUPPORTED;
}
