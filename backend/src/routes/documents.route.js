import express from "express";
import { upload } from "../middlewares/upload.js";
import { requireAuth, requireStepUp } from "../middlewares/auth.js";
import * as ctrl from "../controllers/documents.controller.js";

const router = express.Router();

// Dev identity shim; a real auth middleware mounted upstream will supersede it.
router.use(requireAuth);

// Upload + list within a case
router.post("/cases/:caseId/documents", upload.single("file"), ctrl.createDocument);
router.get("/cases/:caseId/documents", ctrl.listDocuments);

// A single document, its versions, and downloads
router.post("/documents/:id/versions", upload.single("file"), ctrl.addVersion);
router.get("/documents/:id", ctrl.getDocument);
router.get("/documents/:id/versions", ctrl.listVersions);
router.get("/documents/:id/versions/:vid", ctrl.getVersion);
router.get("/documents/:id/versions/:vid/extraction", ctrl.getVersionExtraction);
router.get("/documents/:id/versions/:vid/download", ctrl.download);
router.post("/documents/:id/versions/:vid/restore", ctrl.restoreVersion);

// Integrity layer (ledger read/seal surface)
router.get("/documents/:id/integrity", ctrl.getIntegrity);
router.get("/documents/:id/custody", ctrl.getCustody);
// Seal is a sensitive action: real auth + MFA step-up supersede the currentUser
// dev shim for this route only.
router.post("/documents/:id/seal", requireAuth, requireStepUp, ctrl.sealDocument);

// Access grants: explicit, read-only, time-bound, per-user sharing (in-org and
// cross-org; may cross jurisdiction — see documents.service#grantAccess).
router.post("/documents/:id/access", ctrl.grantDocumentAccess);
router.get("/documents/:id/access", ctrl.listDocumentAccess);
router.delete("/documents/:id/access/:userId", ctrl.revokeDocumentAccess);

export default router;
