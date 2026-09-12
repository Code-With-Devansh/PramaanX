import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import { notificationIdSchema, notificationPaginationSchema } from "../validation/notifications.schema.js";
import * as service from "../services/notifications.service.js";

export async function list(req, res) {
  res.json(await service.listNotifications(req.user.id, parse(notificationPaginationSchema, req.query)));
}

export async function markRead(req, res) {
  await service.markNotificationRead(req.user.id, parse(notificationIdSchema, req.params.id));
  res.status(204).send();
}

export async function markAllRead(req, res) {
  await service.markAllNotificationsRead(req.user.id);
  res.status(204).send();
}