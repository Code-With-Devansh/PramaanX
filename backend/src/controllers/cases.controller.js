import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import {
  assignOfficerSchema,
  createCaseSchema,
  legalHoldSchema,
  listCasesSchema,
  updateCaseSchema,
} from "../validation/cases.schema.js";
import * as service from "../services/cases.service.js";

export async function getCasesPage(req, res) {
  await authorize({ user: req.user, action: "case:list" });
  const filters = parse(listCasesSchema, req.query);
  res.json(await service.listCases({ ...filters, userId: req.user.id }));
}

export async function addCase(req, res) {
  await authorize({ user: req.user, action: "case:create" });
  console.log("Request body:", req.body);
  const values = parse(createCaseSchema, req.body);

  res.status(201).json(await service.createCase(values, req.user.id));
}

export async function getCase(req, res) {
  await authorize({ user: req.user, action: "case:read", resource: { caseId: req.params.id } });
  res.json(await service.getCase(req.params.id));
}

export async function updateCase(req, res) {
  await authorize({ user: req.user, action: "case:update", resource: { caseId: req.params.id } });
  const values = parse(updateCaseSchema, req.body);
  res.json(await service.updateCase(req.params.id, values));
}

export async function addOfficer(req, res) {
  await authorize({ user: req.user, action: "case:manage", resource: { caseId: req.params.id } });
  const values = parse(assignOfficerSchema, req.body);
  res.json(await service.assignOfficer(req.params.id, values, req.user.id));
}

export async function removeOfficerFromCase(req, res) {
  await authorize({ user: req.user, action: "case:manage", resource: { caseId: req.params.id } });
  res.json(await service.removeOfficer(req.params.id, req.params.userId));
}

export async function setHoldReason(req, res) {
  await authorize({ user: req.user, action: "case:legal-hold", resource: { caseId: req.params.id } });
  const { reason } = parse(legalHoldSchema, req.body);
  res.json(await service.placeLegalHold(req.params.id, reason));
}

export async function releaseHold(req, res) {
  await authorize({ user: req.user, action: "case:legal-hold", resource: { caseId: req.params.id } });
  res.json(await service.releaseLegalHold(req.params.id));
}