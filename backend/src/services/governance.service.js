// Facade for the governance HTTP layer. The controller does
// `import * as service from "../services/governance.service.js"` per repo
// convention; the actual logic lives in src/governance/ (proposals.service.js +
// bootstrap.js). This module only re-exports — no logic of its own.

export {
  fileProposal,
  approveProposal,
  objectProposal,
  executeProposal,
  listProposals,
  getProposal,
} from "../governance/proposals.service.js";

export { bootstrap, regenesis } from "../governance/bootstrap.js";
