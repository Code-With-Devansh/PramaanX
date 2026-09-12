import express from "express";
import * as ctrl from "../controllers/cases.controller.js";
import { requireAuth, requireStepUp } from "../middlewares/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/", ctrl.getCasesPage);
router.post("/", ctrl.addCase);
router.get("/:id", ctrl.getCase);
router.patch("/:id", ctrl.updateCase);
router.post("/:id/officers", ctrl.addOfficer);
router.delete("/:id/officers/:userId", ctrl.removeOfficerFromCase);
router.delete("/:id/legal-hold", requireStepUp, ctrl.setHoldReason);
router.post("/:id/legal-hold", requireStepUp, ctrl.releaseHold);

export default router;
