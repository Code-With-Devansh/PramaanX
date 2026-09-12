import { parse } from "../lib/validate.js";
import { authorize } from "../lib/authorize.js";
import * as service from "../services/governance.service.js";
import {
  bootstrapSchema,
  regenesisSchema,
  fileProposalSchema,
  objectSchema,
  listProposalsSchema,
  idParamSchema,
} from "../validation/governance.schema.js";

// Bare async handlers (Express 5 forwards rejections to the error handler). RBAC
// via authorize() is the coarse gate; the authoritative pool-membership / quorum
// checks live in the governance service.

// Genesis ceremony. Intentionally unauthenticated (no admin exists yet) — gated
// by the secret commitment + empty-admin_pools precondition inside the service.
export async function bootstrap(req, res) {
  const body = parse(bootstrapSchema, req.body);
  res.status(201).json(await service.bootstrap(body, req.ip));
}

// Tier-3 re-ceremony. Like bootstrap, unauthenticated + commitment-gated in the
// service (the entire top tier is locked out, so no admin can authenticate).
export async function regenesis(req, res) {
  const body = parse(regenesisSchema, req.body);
  res.status(201).json(await service.regenesis(body, req.ip));
}

export async function fileProposal(req, res) {
  await authorize({ user: req.user, action: "governance:propose" });
  const body = parse(fileProposalSchema, req.body);
  res.status(201).json(await service.fileProposal(req.user.id, body, req.ip));
}

export async function approveProposal(req, res) {
  await authorize({ user: req.user, action: "governance:approve" });
  const id = parse(idParamSchema, req.params.id);
  // req.stepUp.jti is set by requireStepUp; persisted as a one-time vote nonce.
  res
    .status(201)
    .json(await service.approveProposal(req.user.id, id, req.stepUp?.jti, req.ip));
}

export async function objectProposal(req, res) {
  await authorize({ user: req.user, action: "governance:approve" });
  const id = parse(idParamSchema, req.params.id);
  const { reason } = parse(objectSchema, req.body);
  res.json(await service.objectProposal(req.user.id, id, reason, req.ip));
}

export async function executeProposal(req, res) {
  await authorize({ user: req.user, action: "governance:approve" });
  const id = parse(idParamSchema, req.params.id);
  res.json(await service.executeProposal(req.user.id, id, req.ip));
}

export async function listProposals(req, res) {
  await authorize({ user: req.user, action: "governance:read" });
  const filters = parse(listProposalsSchema, req.query);
  res.json(await service.listProposals(filters));
}

export async function getProposal(req, res) {
  await authorize({ user: req.user, action: "governance:read" });
  const id = parse(idParamSchema, req.params.id);
  res.json(await service.getProposal(id));
}
