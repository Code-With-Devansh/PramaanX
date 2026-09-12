// Parse a human-friendly duration ("15m", "1h", "1d", "500ms") into milliseconds.
// Falls back to `fallbackMs` when the value is missing or unparseable. Used to
// keep cookie `maxAge` in lockstep with the JWT `expiresIn` strings below.
function durationToMs(value, fallbackMs) {
  if (value == null || value === "") return fallbackMs;
  const match = String(value).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

// Derive BullMQ/ioredis connection settings. Prefer REDIS_URL (what
// docker-compose sets); fall back to the discrete REDIS_HOST/PORT/PASSWORD vars,
// then to the compose service defaults. Returned as a { host, port, password }
// object because BullMQ builds and owns its own redis client from these.
function redisConnection() {
  let host = process.env.REDIS_HOST || "redis";
  let port = Number(process.env.REDIS_PORT) || 6379;
  let password = process.env.REDIS_PASSWORD || undefined;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      if (u.hostname) host = u.hostname;
      if (u.port) port = Number(u.port);
      // A password-only URL (redis://:pw@host) leaves username empty; decode any
      // percent-escapes so special characters survive.
      if (u.password) password = decodeURIComponent(u.password);
    } catch {
      // Malformed REDIS_URL: ignore it and use the discrete vars above.
    }
  }
  return { host, port, password };
}

export default {
  postgres: {
    url: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 30_000,
    connectionTimeoutMillis:
      Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 10_000,
  },
  storage: {
    // Internal endpoint the API/workers use to reach object storage
    // (http://minio:9000 over the Docker network; the S3/gov-cloud URL in prod).
    endpoint: process.env.STORAGE_ENDPOINT,
    // Endpoint baked into presigned URLs handed to the browser. In dev the
    // browser can't resolve the "minio" service name, so this must be the
    // host-reachable URL (http://localhost:9000). Falls back to `endpoint`.
    publicEndpoint:
      process.env.STORAGE_PUBLIC_ENDPOINT || process.env.STORAGE_ENDPOINT,
    region: process.env.STORAGE_REGION || "us-east-1",
    bucket: process.env.STORAGE_BUCKET || "dms-documents",
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
    // MinIO and other S3-compatibles need path-style addressing
    // (http://host/bucket/key) rather than virtual-host style (bucket.host).
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE || "true") !== "false",
    // Server-side encryption applied at rest on upload. "AES256" = SSE-S3;
    // set blank to disable. The EncryptionProvider seam swaps this for app-level
    // envelope encryption later without touching callers.
    sse: process.env.STORAGE_SSE ?? "AES256",
    // Default lifetime of presigned download URLs, in seconds.
    signedUrlTtlSeconds: Number(process.env.STORAGE_SIGNED_URL_TTL) || 300,
  },
  upload: {
    // Max multipart upload size. Parsed in memory for now (middlewares/upload.js).
    maxFileBytes: Number(process.env.UPLOAD_MAX_BYTES) || 52_428_800, // 50 MiB
  },
  dev: {
    // Fallback identity used by middlewares/currentUser.js until real auth lands.
    userId: process.env.DEV_USER_ID || "00000000-0000-0000-0000-000000000001",
  },
  opensearch: {
    nodes: (process.env.OPENSEARCH_NODES || "http://opensearch:9200").split(","),
    username: process.env.OPENSEARCH_USERNAME || undefined,
    password: process.env.OPENSEARCH_PASSWORD || undefined,
    // Self-signed certs are normal for a dev/on-prem cluster; require a real CA
    // in prod by setting OPENSEARCH_REJECT_UNAUTHORIZED=true.
    rejectUnauthorized: (process.env.OPENSEARCH_REJECT_UNAUTHORIZED || "false") === "true",
    requestTimeoutMs: Number(process.env.OPENSEARCH_REQUEST_TIMEOUT_MS) || 10_000,
  },
    app: {
    env: process.env.NODE_ENV,
    port: Number(process.env.PORT),
  },
  jwt: {
    // Three separate secrets so a leak of one token class can't forge another.
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    // Short-lived token that carries the user between /login and MFA verification,
    // replacing the old plaintext `username` cookie.
    mfaSecret: process.env.JWT_MFA_SECRET,
    // expiresIn strings handed straight to jsonwebtoken.
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES || "1d",
    mfaExpiresIn: process.env.JWT_MFA_EXPIRES || "10m",
    stepUpExpiresIn: process.env.JWT_STEP_UP_EXPIRES || "5m",
    // Matching cookie lifetimes in ms, derived from the same env values.
    accessMaxAgeMs: durationToMs(process.env.JWT_ACCESS_EXPIRES, 15 * 60 * 1000),
    refreshMaxAgeMs: durationToMs(process.env.JWT_REFRESH_EXPIRES, 24 * 60 * 60 * 1000),
    mfaMaxAgeMs: durationToMs(process.env.JWT_MFA_EXPIRES, 10 * 60 * 1000),
  },
  cookie: {
    // In dev the API is served over plain HTTP on localhost, where `secure: true`
    // cookies are silently dropped by browsers — so this defaults to false and
    // should be flipped to true (via env) in any HTTPS deployment.
    secure: (process.env.COOKIE_SECURE || "false") === "true",
    sameSite: process.env.COOKIE_SAMESITE || "strict",
  },
  redis: {
    // Kept for reference/logging; the object below is what BullMQ consumes.
    url: process.env.REDIS_URL,
    connection: redisConnection(),
  },
  ledger: {
    // Master switch. When false, uploads skip enqueue entirely (rows stay
    // PENDING_LEDGER) — for environments with no worker/Redis.
    enabled: (process.env.LEDGER_ENABLED || "true") !== "false",
    // Which LedgerService implementation to construct: "memory" (in-process stub)
    // or "fabric" (real chaincode client — not yet built).
    driver: process.env.LEDGER_DRIVER || "memory",
    queueName: process.env.LEDGER_QUEUE_NAME || "ledger-anchor",
    // Anchor-job retry policy (BullMQ exponential backoff).
    attempts: Number(process.env.LEDGER_ANCHOR_ATTEMPTS) || 5,
    backoffMs: Number(process.env.LEDGER_ANCHOR_BACKOFF_MS) || 5000,
    concurrency: Number(process.env.LEDGER_WORKER_CONCURRENCY) || 4,
    // InMemoryLedgerService knob: "fail" makes every write throw, to exercise the
    // retry -> FAILED path. Any other value = normal operation.
    stubMode: process.env.LEDGER_STUB_MODE || "ok",
    // FabricLedgerService (LEDGER_DRIVER=fabric) coordinates. Only read when the
    // fabric driver is constructed; the cert/key PATHS point at the crypto material
    // mounted into the container (docker-compose.dev.yml), copied DEV-ONLY out of
    // the WSL test-network. peerHostAlias is the peer cert SAN — the gRPC TLS
    // authority override used when dialing host.docker.internal (see fabricLedger.js).
    fabric: {
      channel: process.env.FABRIC_CHANNEL || "legal-channel",
      chaincode: process.env.FABRIC_CHAINCODE || "document",
      mspId: process.env.FABRIC_MSP_ID || "Org1MSP",
      peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || "host.docker.internal:7051",
      peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS || "peer0.org1.example.com",
      tlsRootCertPath: process.env.FABRIC_TLS_ROOT_CERT,
      signCertPath: process.env.FABRIC_SIGN_CERT,
      signKeyPath: process.env.FABRIC_SIGN_KEY,
    },
  },
  governance: {
    // Master switch for the admin-hierarchy / quorum subsystem (GOVERNANCE.md).
    // When false the governance routes still mount but the service refuses to
    // file/approve/execute (for environments not yet bootstrapped).
    enabled: (process.env.GOVERNANCE_ENABLED || "true") !== "false",
    // sha256 hex of the founding secret. The one-time bootstrap ceremony is gated
    // on sha256(providedSecret) === this value (plus the empty-admin_pools
    // precondition). Never store the secret itself — only this commitment.
    genesisCommitment: process.env.GOVERNANCE_GENESIS_COMMITMENT || "",
    // Reserved for the deferred Tier-2 reinstatement window (48–72h). Core
    // proposals execute with no delay (executesAfter = null).
    defaultDelayHours: Number(process.env.GOVERNANCE_DELAY_HOURS) || 72,
    // How many objections halt a PENDING proposal. Default 1 (a single objection
    // stops it) per GOVERNANCE.md's fail-safe stance.
    minObjectorsToHalt: Number(process.env.GOVERNANCE_MIN_OBJECTORS) || 1,
  },
};
