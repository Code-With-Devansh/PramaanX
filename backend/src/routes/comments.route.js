import express from "express";
import { requireAuth } from "../middlewares/auth.js";
import * as ctrl from "../controllers/comments.controller.js";

const router = express.Router();

router.use(requireAuth);

// Case-level thread
router.post("/cases/:caseId/comments", ctrl.createCaseComment);
router.get("/cases/:caseId/comments", ctrl.listCaseComments);

// Document-level thread
router.post("/documents/:id/comments", ctrl.createDocumentComment);
router.get("/documents/:id/comments", ctrl.listDocumentComments);

// A single comment, addressable regardless of which thread it's in
router.patch("/comments/:commentId", ctrl.editComment);
router.delete("/comments/:commentId", ctrl.deleteComment);

export default router;
