import express from "express";
import * as ctrl from "../controllers/governance.controller.js";
import { requireAuth, requireStepUp } from "../middlewares/auth.js";

const router = express.Router();

// Bootstrap is registered BEFORE requireAuth on purpose: at genesis no admin
// exists to authenticate as. It is gated by the secret commitment + the
// empty-admin_pools precondition in the service, and is intended to be reachable
// only over an admin-only channel (called by the genesis CLI). This is the one
// governance route not behind requireAuth — see GOVERNANCE.md §6.4.
router.post("/bootstrap", ctrl.bootstrap);

// Tier-3 recovery ceremony — also before requireAuth (whole top tier locked out,
// no admin to authenticate as). Gated by the genesis commitment in the service,
// mirroring bootstrap. See GOVERNANCE.md §7.3.
router.post("/regenesis", ctrl.regenesis);

router.use(requireAuth);

router.get("/proposals", ctrl.listProposals);
router.post("/proposals", ctrl.fileProposal);
router.get("/proposals/:id", ctrl.getProposal);
router.post("/proposals/:id/object", ctrl.objectProposal);

// approve + execute are each a freshly-authenticated action: requireStepUp
// enforces a per-action step-up token, and approve persists its jti as a
// single-use vote nonce (§4 anti-replay).
router.post("/proposals/:id/approve", requireStepUp, ctrl.approveProposal);
router.post("/proposals/:id/execute", requireStepUp, ctrl.executeProposal);

export default router;
