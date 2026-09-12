import { createHash } from "node:crypto";

// Pure, infra-free helpers behind the integrity/custody endpoints. Kept separate
// from documents.service.js so the hashing, verdict, and custody-mapping logic is
// unit-testable without a DB, object store, or ledger. The service wires these to
// storage.getObject / the ledger seam; see DESIGN §4 for the API shapes.

// Stream a Readable (e.g. storage.getObject().body) through SHA-256 without
// buffering the whole object in memory — evidence files can be large. This is the
// streaming counterpart of the buffer sha256Hex in documents.service.js.
export function sha256HexOfStream(readable) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    readable.on("data", (chunk) => hash.update(chunk));
    readable.on("end", () => resolve(hash.digest("hex")));
    readable.on("error", reject);
  });
}

// Decide a version's integrity verdict from three fingerprints:
//   recomputed — SHA-256 of the bytes actually in storage right now
//   dbSha256   — the hash the mirror recorded at upload
//   ledgerHash — the hash anchored on-chain (null if never anchored)
// Any divergence is TAMPERED. VERIFIED is asserted only once the version is
// anchored AND all three agree — before anchoring there is no independent on-chain
// witness, so the verdict is PENDING (unless storage already diverges from the
// mirror, which is a tamper we surface immediately rather than mask as pending).
export function decideIntegrity({ recomputed, dbSha256, ledgerHash, anchored }) {
  if (!anchored || !ledgerHash) {
    if (recomputed !== dbSha256) return { status: "TAMPERED", matches: false };
    return { status: "PENDING", matches: false };
  }
  const matches = recomputed === ledgerHash && recomputed === dbSha256;
  return { status: matches ? "VERIFIED" : "TAMPERED", matches };
}

// Flatten per-version ledger history into a single chronological chain-of-custody
// trail (DESIGN §4: GET /documents/:id/custody). Input is one { versionNo, entries }
// pair per version, `entries` being the chaincode HistoryEntry[]. Each on-chain
// entry's `value` is the record snapshot at that point, so an event's action/actor
// come from value.lastAction / value.lastActor. Ordered oldest-first.
export function toCustodyEvents(perVersion) {
  const events = [];
  for (const { versionNo, entries } of perVersion) {
    for (const e of entries ?? []) {
      const v = e.value;
      events.push({
        timestamp: new Date(e.timestamp * 1000).toISOString(),
        ts: e.timestamp, // internal sort key; stripped from the payload below
        actor: v?.lastActor ?? v?.actor ?? null,
        action: v?.lastAction ?? null,
        versionNo,
        ledgerTxId: e.txId,
        hash: v?.sha256 ?? null,
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events.map(({ ts, ...ev }) => ev);
}
