import config from "../config/index.js";

export function currentUser(req, res, next) {
  if (!req.user) {
    req.user = { id: config.dev.userId };
  }
  next();
}
