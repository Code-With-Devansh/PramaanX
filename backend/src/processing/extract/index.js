// Text extraction (pipeline stage 2). Dispatches on the *sniffed* content type
// (from the ClamAV stage) with a filename-extension fallback, and returns a
// uniform shape regardless of source:
//
//   { text, method, confidence, pageCount, mimeType }
//
//   method: pdf_native | ocr_paddle | docx | xlsx | plaintext | none
//
// Native parsers are tried first; a PDF that yields too little text per page is
// assumed to be scanned and handed to PaddleOCR. Heavy parser libs are loaded
// lazily so this module imports cleanly in unit tests without them, and a
// missing lib for one format never breaks the others.

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const TEXT_MIMES = new Set(["text/plain", "text/csv", "application/csv", "text/markdown"]);

const extOf = (name = "") => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

const empty = (mimeType) => ({ text: "", method: "none", confidence: null, pageCount: null, mimeType });

/**
 * @param {{
 *   ocrClient: { ocr: (i: { buffer: Buffer, fileName: string, mimeType: string }) => Promise<{ text: string, confidence: number|null, pageCount: number|null }> },
 *   minCharsPerPage?: number,
 * }} deps
 */
export function createExtractor({ ocrClient, minCharsPerPage = 100 }) {
  async function fromPdf({ buffer, fileName, mimeType }) {
    let parsed;
    try {
      const { default: pdfParse } = await import("pdf-parse");
      parsed = await pdfParse(buffer);
    } catch (err) {
      // A corrupt/encrypted PDF that pdf-parse can't open: fall back to OCR
      // rather than failing the whole job.
      console.warn(`[extract] pdf-parse failed (${err?.message ?? err}); trying OCR`);
      return fromOcr({ buffer, fileName, mimeType });
    }
    const pages = parsed.numpages || 1;
    const text = parsed.text ?? "";
    const dense = text.replace(/\s/g, "").length >= minCharsPerPage * pages;
    if (dense) {
      return { text, method: "pdf_native", confidence: null, pageCount: pages, mimeType };
    }
    // Looks scanned — OCR it, but keep whatever native text we did get as a
    // floor in case OCR comes back worse.
    const ocr = await fromOcr({ buffer, fileName, mimeType });
    return ocr.text.length >= text.length
      ? ocr
      : { text, method: "pdf_native", confidence: null, pageCount: pages, mimeType };
  }

  async function fromOcr({ buffer, fileName, mimeType }) {
    const { text, confidence, pageCount } = await ocrClient.ocr({ buffer, fileName, mimeType });
    return { text: text ?? "", method: "ocr_paddle", confidence, pageCount, mimeType };
  }

  async function fromDocx({ buffer, mimeType }) {
    const mammoth = await import("mammoth");
    const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer });
    return { text: value ?? "", method: "docx", confidence: null, pageCount: null, mimeType };
  }

  async function fromSpreadsheet({ buffer, mimeType }) {
    const xlsx = await import("xlsx");
    const XLSX = xlsx.default ?? xlsx;
    const wb = XLSX.read(buffer, { type: "buffer" });
    const parts = wb.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return csv.trim() ? `# ${name}\n${csv}` : "";
    }).filter(Boolean);
    return { text: parts.join("\n\n"), method: "xlsx", confidence: null, pageCount: wb.SheetNames.length, mimeType };
  }

  function fromPlainText({ buffer, mimeType }) {
    return { text: buffer.toString("utf8"), method: "plaintext", confidence: null, pageCount: null, mimeType };
  }

  /**
   * @param {{ buffer: Buffer, mimeType: string, fileName: string }} input
   */
  async function extractText({ buffer, mimeType, fileName }) {
    const mime = (mimeType || "").toLowerCase();
    const ext = extOf(fileName);

    if (mime === PDF_MIME || ext === "pdf") return fromPdf({ buffer, fileName, mimeType: mime || PDF_MIME });
    if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"].includes(ext)) {
      return fromOcr({ buffer, fileName, mimeType: mime || `image/${ext}` });
    }
    if (mime === DOCX_MIME || ext === "docx") return fromDocx({ buffer, mimeType: mime || DOCX_MIME });
    if (XLSX_MIMES.has(mime) || ["xlsx", "xls"].includes(ext)) {
      return fromSpreadsheet({ buffer, mimeType: mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    if (TEXT_MIMES.has(mime) || ["txt", "csv", "md", "markdown"].includes(ext)) {
      return fromPlainText({ buffer, mimeType: mime || "text/plain" });
    }
    return empty(mime || "application/octet-stream");
  }

  return { extractText };
}
