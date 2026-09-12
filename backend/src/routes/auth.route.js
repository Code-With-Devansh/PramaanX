import express from "express";
import * as ctrl from "../controllers/auth.controller.js";
import { requireAuth } from "../middlewares/auth.js";

const router = express.Router();

// Login + MFA handshake
router.post("/auth/login", ctrl.login);
router.post("/auth/mfa/enroll/start", ctrl.startMfaEnrollment);
router.post("/auth/mfa/enroll/verify", ctrl.verifyMfaEnrollment);
router.post("/auth/mfa/verify", ctrl.verifyMfa);
router.post("/auth/step-up", requireAuth, ctrl.stepUp);

// Session lifecycle
router.post("/auth/refresh", ctrl.refresh);
router.post("/auth/logout", requireAuth, ctrl.logout);


router.post("/auth/change-password", requireAuth, ctrl.changePassword);
router.post("/activate", ctrl.activateAccount);

// Current user (requires a valid access token)
router.get("/auth/me", requireAuth, ctrl.aboutUser);


export default router;
