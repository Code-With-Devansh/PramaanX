import express from "express";
import * as controller from "../controllers/notifications.controller.js";
import { requireAuth } from "../middlewares/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/notifications", controller.list);
router.post("/notifications/read-all", controller.markAllRead);
router.post("/notifications/:id/read", controller.markRead);

export default router;