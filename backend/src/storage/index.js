import config from "../config/index.js";
import { s3, s3Signer } from "../config/storage.js";
import { createS3StorageProvider } from "./provider.js";
import { createServerSideEncryption } from "./encryption.js";

// App-wide storage singleton. Import { storage } from here in services/workers;
// nothing outside this module should touch the S3 SDK directly.
const encryption = createServerSideEncryption({ sse: config.storage.sse });

export const storage = createS3StorageProvider({
  client: s3,
  signer: s3Signer,
  bucket: config.storage.bucket,
  encryption,
  signedUrlTtlSeconds: config.storage.signedUrlTtlSeconds,
});

export { versionStorageKey } from "./keys.js";
export { ObjectNotFoundError } from "./provider.js";
export { DownloadMode } from "./encryption.js";
