import express from "express";
import * as ctrl from "../controllers/reference.controller.js";
import { requireAuth } from "../middlewares/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/orgs", ctrl.orgs.list);
router.post("/orgs", ctrl.orgs.create);
router.get("/orgs/:id", ctrl.orgs.get);
router.patch("/orgs/:id", ctrl.orgs.update);
router.delete("/orgs/:id", ctrl.orgs.remove);

router.get("/jurisdictions", ctrl.jurisdictions.list);
router.post("/jurisdictions", ctrl.jurisdictions.create);
router.get("/jurisdictions/:id", ctrl.jurisdictions.get);
router.patch("/jurisdictions/:id", ctrl.jurisdictions.update);
router.delete("/jurisdictions/:id", ctrl.jurisdictions.remove);

export default router;
