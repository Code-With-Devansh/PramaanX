import multer from "multer";
import config from "../config/index.js";

// In-memory multipart parsing — fine for the modest evidence files handled now.
// The storage provider also accepts streams (via lib-storage) if we later switch
// to streaming large uploads. Field "file" is the binary; "metadata" is JSON text.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxFileBytes, files: 1 },
});
