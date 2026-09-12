// ─────────────────────────────────────────────────────────────────────────────
// EncryptionProvider seam.
//
// Phase 1 (now): server-side encryption. The app hands plaintext to storage and
// lets MinIO/S3 encrypt at rest (SSE-S3). Presigned URLs return usable bytes, so
// downloads go client -> storage directly (DownloadMode.PRESIGNED).
//
// Phase 2 (later): app-level envelope encryption can replace this WITHOUT
// changing any storage caller — implement the same shape:
//   • encryptUpload   wrap the body, return ciphertext + per-object key metadata
//   • decryptDownload unwrap and decrypt the stream
//   • putParams       drop the SSE header (storage only ever sees ciphertext)
//   • downloadMode    switch to PROXY (bytes are ciphertext; the API must
//                     stream-decrypt, so §13.4's signed URL becomes an API URL)
// The provider/service surface stays identical; only this file and the download
// route's mode branch change.
// ─────────────────────────────────────────────────────────────────────────────

export const DownloadMode = Object.freeze({
  PRESIGNED: "presigned",
  PROXY: "proxy",
});

// Server-side encryption: storage does the crypto. `sse` is the value sent as
// the ServerSideEncryption header on PutObject ("AES256" for SSE-S3), or falsy
// to upload without an at-rest encryption request.
export function createServerSideEncryption({ sse } = {}) {
  return {
    downloadMode: DownloadMode.PRESIGNED,

    // Extra params merged into PutObject. Under SSE this asks storage to encrypt
    // the object at rest; under envelope encryption it would be empty.
    putParams() {
      return sse ? { ServerSideEncryption: sse } : {};
    },

    // No-ops here — storage does the crypto. These become real transforms under
    // app-level envelope encryption.
    async encryptUpload(body) {
      return { body, metadata: {} };
    },
    async decryptDownload(stream) {
      return stream;
    },
  };
}
