import express from "express";
import { requireAuth } from "../middlewares/auth.js";
import * as ctrl from "../controllers/search.controller.js";

const router = express.Router();

router.use(requireAuth);
router.get("/search", ctrl.search);

export default router;
