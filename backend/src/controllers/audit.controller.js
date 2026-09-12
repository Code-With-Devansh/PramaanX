import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import { auditQuerySchema } from "../validation/audit.schema.js";
import { listAudit, verifyAuditChain } from "../audit/index.js";

// GET /audit — paginated, filterable audit trail (Auditor surface, contract §8).
export async function list(req, res) {
  await authorize({ user: req.user, action: "audit:read", resource: {} });
  const { page, pageSize, ...filters } = parse(auditQuerySchema, req.query);
  res.json(await listAudit(filters, { page, pageSize }));
}

// GET /audit/verify — re-walk the hash chain and report whether it's intact.
// Not in the contract; a convenience/health check for the tamper-evidence chain.
export async function verify(req, res) {
  await authorize({ user: req.user, action: "audit:verify", resource: {} });
  res.json(await verifyAuditChain());
}
