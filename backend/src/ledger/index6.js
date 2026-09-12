import config from "../config/index.js";
import { createInMemoryLedgerService } from "./inMemoryLedger.js";
import { createFabricLedgerService } from "./fabricLedger.js";

// App-wide LedgerService singleton. Import { ledger } from here in the anchor
// worker (and, later, custody/seal/verify handlers); nothing else should
// construct a ledger client directly. The driver is chosen once at boot from
// config.ledger.driver so swapping the in-memory stub for the real Fabric client
// is an env change, not a code change.

/** @returns {import("./types.js").LedgerService} */
function buildLedger() {
  switch (config.ledger.driver) {
    case "memory":
      return createInMemoryLedgerService({ mode: config.ledger.stubMode });
    case "fabric":
      // Real @hyperledger/fabric-gateway client against the deployed `document`
      // chaincode. The native gRPC/gateway deps load lazily here (createRequire in
      // fabricLedger.js), so a "memory" boot never needs them installed.
      return createFabricLedgerService(config.ledger.fabric);
    default:
      throw new Error(`unknown LEDGER_DRIVER: ${config.ledger.driver}`);
  }
}

export const ledger = buildLedger();
