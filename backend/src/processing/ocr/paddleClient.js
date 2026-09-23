// Thin HTTP client for the PaddleOCR sidecar (services/ocr/, docker-compose
// service `ocr`). The worker calls this for scanned PDFs and images; all model
// handling lives in the Python service.

/**
 * @param {{ url: string, timeoutMs?: number, lang?: string }} cfg
 */
export function createPaddleOcrClient({ url, timeoutMs = 120_000, lang = "en" }) {
  const base = url.replace(/\/+$/, "");

  /**
   * @param {{ buffer: Buffer, fileName: string, mimeType: string }} input
   * @returns {Promise<{ text: string, confidence: number|null, pageCount: number|null }>}
   */
  async function ocr({ buffer, fileName, mimeType }) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([buffer], { type: mimeType || "application/octet-stream" }),
      fileName || "upload",
    );
    form.append("lang", lang);

    // One retry: the first request after container start can race model load.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/ocr`, {
          method: "POST",
          body: form,
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`ocr service ${res.status}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        return {
          text: json.text ?? "",
          confidence: json.confidence ?? null,
          pageCount: json.pages ?? null,
        };
      } catch (err) {
        lastErr = err;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        clearTimeout(timer);
      }
    }
    // fetch()'s TypeError("fetch failed") hides the real DNS/connect/TLS error
    // in `.cause` — surface it so failures are diagnosable instead of generic.
    const detail = lastErr?.cause?.message ?? lastErr?.message ?? lastErr;
    throw new Error(`PaddleOCR request failed: ${detail}`, { cause: lastErr });
  }

  async function ping() {
    const res = await fetch(`${base}/health`);
    return res.ok;
  }

  return { ocr, ping };
}