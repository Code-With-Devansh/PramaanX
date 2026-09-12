import { S3Client } from "@aws-sdk/client-s3";
import config from "./index.js";

// S3-compatible object storage clients (MinIO in dev, S3/gov-cloud in prod).
// Documents live here; Postgres holds only metadata, hashes and the audit chain.

const {
  endpoint,
  publicEndpoint,
  region,
  accessKeyId,
  secretAccessKey,
  forcePathStyle,
} = config.storage;

// Fail fast, mirroring config/db.js's treatment of DATABASE_URL.
if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error(
    "[storage] STORAGE_ENDPOINT, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be set",
  );
  process.exit(1);
}

const credentials = { accessKeyId, secretAccessKey };

// Client for server-side operations (put/get/stat/delete). Talks to the
// internal endpoint reachable from the API/worker containers.
// Newer SDK versions default to attaching integrity checksums (CRC32 headers/
// trailers) to requests like CreateBucket/PutObject. MinIO 400s on these, and
// returns the error body in a shape the SDK's newer error parser can't decode
// — surfacing as an opaque "Unknown: UnknownError" instead of a normal S3
// error, which is what was crashing ensureBucket() before the app could boot.
// WHEN_REQUIRED restores the old (pre-checksum-by-default) behavior.
const checksumOverrides = {
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
};

export const s3 = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials,
  ...checksumOverrides,
});

// Client used ONLY to presign download URLs. It signs against the public
// endpoint so the URLs resolve from the user's browser rather than the internal
// Docker network. When no public endpoint is configured it matches `s3`.
export const s3Signer = new S3Client({
  endpoint: publicEndpoint || endpoint,
  region,
  forcePathStyle,
  credentials,
  ...checksumOverrides,
});