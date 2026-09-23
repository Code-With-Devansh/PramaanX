import { useEffect, useMemo, useState } from "react";

import mammoth from "mammoth";

import { api } from "../../lib/api";

import { formatBytes } from "../../lib/format";

import { Button, Spinner } from "../../components/ui";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

const PDF_EXTS = ["pdf"];

const TEXT_EXTS = ["txt", "csv", "log", "md", "json"];

const DOCX_EXTS = ["docx"];

const MIME_BY_EXT = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  log: "text/plain",
  md: "text/markdown",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function extOf(fileName = "") {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function kindFor(fileName, mimeType) {
  const mime = (mimeType || "").toLowerCase();

  if (mime.includes("pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (
    mime.includes(
      "vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
  )
    return "docx";
  if (mime.startsWith("text/")) return "text";

  const ext = extOf(fileName);

  if (PDF_EXTS.includes(ext)) return "pdf";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (DOCX_EXTS.includes(ext)) return "docx";
  if (TEXT_EXTS.includes(ext)) return "text";

  return "unsupported";
}

export default function DocumentPreview({
  documentId,
  versionId,
  fileName,
  mimeType,
  sizeBytes,
}) {
  // `downloadUrl` is the raw signed URL from the API — used for "open in new
  // tab" / manual download. `previewUrl` is a same-origin blob: URL we build
  // ourselves, because most signed storage URLs (S3, GCS, etc.) come back
  // with `Content-Disposition: attachment`, which makes the browser force a
  // download the instant you point an <iframe>/<object>/<img> at them
  // directly. Fetching the bytes and re-wrapping them as a blob sidesteps
  // that header entirely so the file renders inline instead.
  const [downloadUrl, setDownloadUrl] = useState(null);

  const [previewUrl, setPreviewUrl] = useState(null);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState("");

  const [zoom, setZoom] = useState(1);

  const [docxHtml, setDocxHtml] = useState("");

  const kind = useMemo(
    () => kindFor(fileName, mimeType),
    [fileName, mimeType]
  );

  useEffect(() => {
    if (!versionId) return;

    let cancelled = false;
    let objectUrl = null;

    setLoading(true);
    setError("");
    setDownloadUrl(null);
    setPreviewUrl(null);
    setDocxHtml("");
    setZoom(1);

    (async () => {
      try {
        const linkRes = await api.get(
          `/documents/${documentId}/versions/${versionId}/download`
        );

        const signedUrl = linkRes.data.url;

        if (cancelled) return;

        setDownloadUrl(signedUrl);

        // Pull the actual bytes so we can render them same-origin.
        const fileRes = await fetch(signedUrl);

        if (!fileRes.ok) {
          throw new Error(`Fetch failed (${fileRes.status})`);
        }

        let blob = await fileRes.blob();

        // Some storage backends serve everything as
        // application/octet-stream, which makes browsers download rather
        // than render. Re-tag the blob with the type we expect from the
        // filename so <iframe>/<img> know what to do with it.
        const expectedMime = MIME_BY_EXT[extOf(fileName)];

        if (expectedMime && blob.type !== expectedMime) {
          blob = blob.slice(0, blob.size, expectedMime);
        }

        if (cancelled) return;

        if (kind === "docx") {
          // mammoth needs the raw bytes, not a blob: URL, so convert
          // straight to sanitized-ish HTML we render into the page.
          const arrayBuffer = await blob.arrayBuffer();

          const { value: html } = await mammoth.convertToHtml({
            arrayBuffer,
          });

          if (cancelled) return;

          setDocxHtml(html);
        } else {
          objectUrl = URL.createObjectURL(blob);
          setPreviewUrl(objectUrl);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err?.response?.data?.error?.message ||
              "Could not load a preview for this file. You can still open or download it."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [documentId, versionId, fileName, kind]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-slate-200 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">
            {fileName || "Document"}
          </p>

          {sizeBytes != null && (
            <p className="text-xs text-slate-400">
              {formatBytes(sizeBytes)}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {kind === "image" && previewUrl && (
            <>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() =>
                  setZoom((z) => Math.max(0.25, z - 0.25))
                }
              >
                −
              </Button>

              <span className="w-10 shrink-0 text-center text-xs text-slate-500">
                {Math.round(zoom * 100)}%
              </span>

              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() =>
                  setZoom((z) => Math.min(4, z + 0.25))
                }
              >
                +
              </Button>
            </>
          )}

          {downloadUrl && (
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={() =>
                window.open(
                  downloadUrl,
                  "_blank",
                  "noopener,noreferrer"
                )
              }
            >
              Open in new tab ↗
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-slate-100">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center sm:px-6">
            <p className="wrap-break-words text-sm text-red-600">
              {error}
            </p>

            {downloadUrl && (
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    downloadUrl,
                    "_blank",
                    "noopener,noreferrer"
                  )
                }
              >
                Open file
              </Button>
            )}
          </div>
        )}

        {!loading &&
          !error &&
          previewUrl &&
          kind === "pdf" && (
            <iframe
              src={previewUrl}
              title={fileName || "Document preview"}
              className="h-full w-full min-w-0 border-0"
            />
          )}

        {!loading &&
          !error &&
          previewUrl &&
          kind === "image" && (
            <div className="flex min-h-full min-w-0 items-center justify-center overflow-auto p-3 sm:p-4">
              <img
                src={previewUrl}
                alt={fileName || "Document preview"}
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "center",
                }}
                className="max-w-none select-none rounded shadow-sm transition-transform"
                draggable={false}
              />
            </div>
          )}

        {!loading && !error && kind === "docx" && docxHtml && (
          <div className="flex min-h-full min-w-0 justify-center p-3 sm:p-6">
            <div
              className="docx-preview w-full max-w-3xl rounded bg-white p-6 text-sm text-slate-800 shadow-sm sm:p-10"
              dangerouslySetInnerHTML={{ __html: docxHtml }}
            />
          </div>
        )}

        {!loading &&
          !error &&
          previewUrl &&
          kind === "text" && (
            <iframe
              src={previewUrl}
              title={fileName || "Document preview"}
              className="h-full w-full min-w-0 border-0 bg-white"
            />
          )}

        {!loading &&
          !error &&
          previewUrl &&
          kind === "unsupported" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center sm:px-6">
              <div className="text-4xl">📄</div>

              <p className="text-sm font-medium text-slate-700">
                No inline preview for this file type
              </p>

              <p className="max-w-full wrap-break-words text-xs text-slate-500">
                {fileName}
              </p>

              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    downloadUrl,
                    "_blank",
                    "noopener,noreferrer"
                  )
                }
              >
                Download to view
              </Button>
            </div>
          )}
      </div>
    </div>
  );
}