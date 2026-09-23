import net from "node:net";
import { fileTypeFromBuffer } from "file-type";

// ── ClamAV scanner (pipeline stage 1) ───────────────────────────────────────
// A tiny clamd INSTREAM client — no local `clamscan`/`clamdscan` binary, no
// temp files: the bytes are already in the worker's memory. Talks to the
// `clamav` docker-compose service over TCP.
//
// FAIL-CLOSED is the caller's contract: this module throws on any transport /
// protocol error so the BullMQ job retries; it only ever returns
// { clean: false } for a genuine positive detection or a disallowed file type.
// Nothing downstream runs without { clean: true }.

// Real content types the pipeline is willing to extract. A file whose *sniffed*
// type is outside this set is treated exactly like a detection (QUARANTINED) —
// we don't hand unknown binaries to the parsers or OCR. text/plain and CSV have
// no magic bytes, so `file-type` returns undefined for them; that's handled as
// "allowed if the declared type is textual" below.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/msword",
  "application/vnd.ms-excel",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);

const TEXTUAL_DECLARED = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "text/markdown",
]);

const CHUNK = 64 * 1024;

/**
 * @param {{ host: string, port: number, timeoutMs?: number }} cfg
 */
export function createClamAvScanner({ host, port, timeoutMs = 30_000 }) {
  // Low-level: stream one buffer through clamd INSTREAM, resolve its verdict line.
  function instream(buffer) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let response = "";
      let settled = false;

      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn(arg);
      };

      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => done(reject, new Error("clamd timeout")));
      socket.on("error", (err) => done(reject, err));
      socket.on("data", (d) => (response += d.toString("utf8")));
      socket.on("end", () => {
        // zINSTREAM replies are NUL-terminated on the wire (e.g. "stream: OK\0");
        // .trim() only strips whitespace, so the trailing \0 survives and breaks
        // the end-anchored regexes below unless it's stripped first.
        const line = response.replace(/\0+$/, "").trim();
        // "stream: OK" | "stream: <Sig> FOUND" | "... ERROR"
        if (/\bOK$/.test(line)) return done(resolve, { clean: true, signature: null });
        const found = line.match(/stream:\s+(.*)\s+FOUND$/);
        if (found) return done(resolve, { clean: false, signature: found[1] });
        done(reject, new Error(`clamd unexpected response: ${line || "<empty>"}`));
      });

      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let off = 0; off < buffer.length; off += CHUNK) {
          const slice = buffer.subarray(off, off + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(slice.length, 0);
          socket.write(size);
          socket.write(slice);
        }
        // zero-length chunk = end of stream
        socket.write(Buffer.from([0, 0, 0, 0]));
      });
    });
  }

  /**
   * @param {Buffer} buffer
   * @param {{ declaredMimeType?: string, fileName?: string, versionId?: string }} ctx
   * @returns {Promise<{ clean: boolean, signature: string|null, mimeType: string }>}
   */
  async function scan(buffer, ctx = {}) {
    // 1. Type sniff first — cheap, and a mismatch is itself a quarantine reason.
    const sniffed = await fileTypeFromBuffer(buffer);
    const declared = (ctx.declaredMimeType || "").toLowerCase();
    const realMime = sniffed?.mime ?? (TEXTUAL_DECLARED.has(declared) ? declared : "application/octet-stream");

    const typeAllowed = sniffed
      ? ALLOWED_MIME.has(sniffed.mime)
      : TEXTUAL_DECLARED.has(declared);

    if (!typeAllowed) {
      return {
        clean: false,
        signature: `Pipeline.DisallowedType.${sniffed?.mime ?? declared ?? "unknown"}`,
        mimeType: realMime,
      };
    }

    // 2. ClamAV. Any transport/protocol failure throws -> job retries (fail-closed).
    const verdict = await instream(buffer);
    return { ...verdict, mimeType: realMime };
  }

  // Reachability probe for logging/health.
  async function ping() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => (socket.destroy(), reject(new Error("clamd timeout"))));
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("zPING\0");
      });
      socket.on("data", (d) => {
        socket.destroy();
        resolve(d.toString().trim() === "PONG");
      });
    });
  }

  return { scan, ping };
}