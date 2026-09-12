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
export const s3 = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials,
});

// Client used ONLY to presign download URLs. It signs against the public
// endpoint so the URLs resolve from the user's browser rather than the internal
// Docker network. When no public endpoint is configured it matches `s3`.
export const s3Signer = new S3Client({
  endpoint: publicEndpoint || endpoint,
  region,
  forcePathStyle,
  credentials,
});
