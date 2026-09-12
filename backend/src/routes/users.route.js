import express from "express";
import * as ctrl from "../controllers/users.controller.js";
import { requireAuth, requireStepUp } from "../middlewares/auth.js";

const router = express.Router();
router.use(requireAuth);
router.get("/users", ctrl.list);
router.post("/users", ctrl.create);
router.get("/users/:id", ctrl.get);
router.patch("/users/:id", requireStepUp, ctrl.update);
router.post("/users/:id/deactivate", requireStepUp, ctrl.deactivate);
router.post("/users/:id/reset-mfa", ctrl.resetMfa);
router.get("/users/:id/sessions", ctrl.sessions);
router.delete("/sessions/:sessionId", requireStepUp, ctrl.deleteSession);

export default router;