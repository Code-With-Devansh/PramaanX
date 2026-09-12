import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import { searchQuerySchema } from "../validation/search.schema.js";
import * as service from "../services/search.service.js";

export async function search(req, res) {
  // Coarse RBAC gate only (no resource in scope — a search spans many cases).
  // Fine-grained per-document authorization happens inside searchDocuments()
  // via the same authorize() path every other document read goes through.
  await authorize({ user: req.user, action: "document:list", resource: {} });
  const query = parse(searchQuerySchema, req.query);
  const result = await service.searchDocuments({ user: req.user, ...query });
  res.json(result);
}
