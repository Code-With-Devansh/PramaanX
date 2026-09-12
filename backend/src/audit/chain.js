import { createHash } from "node:crypto";

// The prev_hash of the very first (genesis) entry: 64 hex zeros.
export const GENESIS_HASH = "0".repeat(64);

// Deterministic JSON serialization: object keys sorted recursively, no incidental
// whitespace. jsonb loses key order on round-trip, so the hashed form MUST be
// order-independent for verification to reproduce it from the stored row.
export function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
    .join(",")}}`;
}

// The exact bytes an entry_hash commits to. `seq` is deliberately excluded — the
// chain's integrity comes from the prev_hash linkage, not the sequence number,
// and seq isn't known until the DB assigns it. createdAt is normalized to an ISO
// string so a Date read back from Postgres reproduces the same input.
export function entryPayload(entry) {
  return canonicalize({
    id: entry.id,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    details: entry.details ?? null,
    createdAt: new Date(entry.createdAt).toISOString(),
  });
}

// entry_hash = sha256(prev_hash || canonical(payload)).
export function computeEntryHash(prevHash, entry) {
  return createHash("sha256")
    .update(prevHash)
    .update(entryPayload(entry))
    .digest("hex");
}
