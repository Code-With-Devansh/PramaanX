import { parse } from "../lib/validate.js";
import { authorize } from "../lib/authorize.js";
import * as service from "../services/users.service.js";
import { idSchema, listUsersSchema, provisionUserSchema, updateUserSchema } from "../validation/users.schema.js";

async function requirePermission(req, action) {
  await authorize({ user: req.user, action });
}

export async function list(req, res) {
  await requirePermission(req, "user:read");
  const filters = parse(listUsersSchema, req.query);
  res.json(await service.listUsers(req.user, filters));
}

export async function create(req, res) {
  await requirePermission(req, "user:manage");
  res.status(201).json(await service.provisionUser(req.user, parse(provisionUserSchema, req.body), req.ip));
}

export async function get(req, res) {
  await requirePermission(req, "user:read");
  res.json(await service.getUser(req.user, parse(idSchema, req.params.id)));
}

export async function update(req, res) {
  await requirePermission(req, "user:manage");
  res.json(await service.updateUser(req.user, parse(idSchema, req.params.id), parse(updateUserSchema, req.body), req.ip));
}

export async function deactivate(req, res) {
  await requirePermission(req, "user:manage");
  res.json(await service.deactivateUser(req.user, parse(idSchema, req.params.id), req.ip));
}

export async function resetMfa(req, res) {
  await requirePermission(req, "user:manage");
  await service.resetMfa(req.user, parse(idSchema, req.params.id), req.ip);
  res.status(204).send();
}

export async function sessions(req, res) {
  await requirePermission(req, "user:read");
  res.json({ items: await service.listSessions(req.user, parse(idSchema, req.params.id)) });
}

export async function deleteSession(req, res) {
  await requirePermission(req, "user:manage");
  await service.revokeSession(req.user, parse(idSchema, req.params.sessionId));
  res.status(204).send();
}