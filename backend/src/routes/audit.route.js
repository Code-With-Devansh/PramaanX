import express from "express";
import { currentUser } from "../middlewares/currentUser.js";
import * as ctrl from "../controllers/audit.controller.js";

const router = express.Router();

// Dev identity shim; a real auth middleware mounted upstream will supersede it.
router.use(currentUser);

router.get("/audit", ctrl.list);
router.get("/audit/verify", ctrl.verify);

export default router;
