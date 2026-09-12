import {
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { DownloadMode } from "./encryption.js";

// Raised when an object/bucket isn't found, so callers can map it to a clean
// 404 (NOT_FOUND) instead of leaking the raw SDK error.
export class ObjectNotFoundError extends Error {
  constructor(key) {
    super(`storage object not found: ${key}`);
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

function isNotFound(err) {
  const code = err?.name || err?.Code;
  return (
    code === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NoSuchBucket" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

const stripQuotes = (etag) =>
  typeof etag === "string" ? etag.replace(/^"|"$/g, "") : etag;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Storage-agnostic surface over an S3-compatible backend (MinIO in dev,
// S3/gov-cloud in prod). The rest of the app depends on THIS, never on the SDK,
// so swapping backends — or the SDK itself — touches only this file.
export function createS3StorageProvider({
  client,
  signer,
  bucket,
  encryption,
  signedUrlTtlSeconds = 300,
}) {
  signer = signer || client;

  // Create the bucket if absent. Retries so a not-quite-ready MinIO on the first
  // `docker compose up` doesn't crash boot.
  async function ensureBucket({ retries = 10, delayMs = 1500 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch (err) {
        if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          return;
        }
        // Connection refused / DNS not resolving yet: back off and retry.
        if (attempt >= retries) throw err;
        await sleep(delayMs);
      }
    }
  }

  // Reachability probe for health checks — throws if storage is unreachable.
  async function ping() {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  }

  // Upload bytes. `body` may be a Buffer, string or Readable stream; lib-storage
  // streams it in parts, so large evidence files don't buffer in memory.
  async function putObject({ key, body, contentType, metadata }) {
    const { body: outBody, metadata: encMeta } =
      await encryption.encryptUpload(body);
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: outBody,
        ContentType: contentType,
        Metadata: { ...(metadata || {}), ...encMeta },
        ...encryption.putParams(),
      },
    });
    const res = await upload.done();
    return { key, etag: stripQuotes(res.ETag) };
  }

  // Fetch an object for server-side use (virus scan, OCR, re-hash for
  // integrity). Returns a Readable stream. Throws ObjectNotFoundError if absent.
  async function getObject(key) {
    let res;
    try {
      res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
    return {
      body: await encryption.decryptDownload(res.Body), // Readable stream
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      etag: stripQuotes(res.ETag),
    };
  }

  // Metadata only (size/type/etag) — cheap existence and integrity checks.
  async function statObject(key) {
    try {
      const res = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        size: res.ContentLength,
        contentType: res.ContentType,
        etag: stripQuotes(res.ETag),
        lastModified: res.LastModified,
      };
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async function objectExists(key) {
    try {
      await statObject(key);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  }

  // Cleanup only (e.g. a failed/orphaned upload). Document VERSIONS are evidence
  // and are never hard-deleted — that soft-delete lives in the documents domain,
  // guarded by legal hold, not here.
  async function deleteObject(key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  // Duplicate an existing object to a new key. Used by version restore: a restored
  // version is a brand-new immutable version that owns its own bytes, so we copy
  // the source object rather than share a storage key. Under server-side
  // encryption (PRESIGNED mode) this is a server-side copy — bytes never transit
  // the app — re-encrypted at rest exactly like a fresh upload. Under envelope
  // encryption (PROXY mode) the stored bytes are ciphertext under a per-object
  // key, so we must re-key by streaming decrypt-on-read -> encrypt-on-write.
  // Throws ObjectNotFoundError if the source is missing.
  async function copyObject({ sourceKey, destKey, contentType, metadata }) {
    if (encryption.downloadMode === DownloadMode.PRESIGNED) {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: destKey,
            // Keys are UUID path segments (hex + '/'), so no escaping is needed.
            CopySource: `${bucket}/${sourceKey}`,
            MetadataDirective: "COPY", // carry content-type + user metadata (sha256)
            ...encryption.putParams(),
          }),
        );
      } catch (err) {
        if (isNotFound(err)) throw new ObjectNotFoundError(sourceKey);
        throw err;
      }
      return { key: destKey };
    }
    const src = await getObject(sourceKey);
    return putObject({
      key: destKey,
      body: src.body,
      contentType: contentType ?? src.contentType,
      metadata,
    });
  }

  // Presigned, time-limited download URL — the { url, expiresAt } of API §13.4.
  // Valid only when the encryption mode yields usable bytes to a direct fetch
  // (server-side encryption). Under envelope encryption the download must proxy
  // through the API, so we fail loudly rather than hand out a URL to ciphertext.
  async function getSignedDownloadUrl(
    key,
    { expiresIn, fileName, contentType } = {},
  ) {
    if (encryption.downloadMode !== DownloadMode.PRESIGNED) {
      throw new Error(
        "presigned download unavailable under current encryption mode; stream via getObject()",
      );
    }
    const ttl = expiresIn ?? signedUrlTtlSeconds;
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: fileName
        ? `attachment; filename="${encodeURIComponent(fileName)}"`
        : undefined,
      ResponseContentType: contentType,
    });
    const url = await getSignedUrl(signer, cmd, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  return {
    bucket,
    // Fixed at construction; lets the future download route branch without
    // reaching into the encryption provider.
    downloadMode: encryption.downloadMode,
    ensureBucket,
    ping,
    putObject,
    getObject,
    statObject,
    objectExists,
    deleteObject,
    copyObject,
    getSignedDownloadUrl,
  };
}
