import { MulterError } from "multer";
import { ApiError } from "../lib/errors.js";

// Central error handler — mounted last in app.js. Maps known errors to the
// DESIGN §13 envelope; anything unexpected becomes a 500. The unused `next` is
// required: Express only treats a 4-arg function as error middleware.
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "file exceeds the maximum allowed size"
        : err.message;
    return res.status(400).json({ error: { code: "VALIDATION", message } });
  }
  console.error("[error] unhandled:", err);
  return res
    .status(500)
    .json({ error: { code: "INTERNAL", message: "internal server error" } });
}
