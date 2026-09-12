import { z } from "zod";
import { AuditAction, TargetType } from "../audit/actions.js";

// Loose UUID-shape check that mirrors what Postgres's `uuid` type accepts, rather
// than zod's strict .uuid() (which enforces RFC version/variant nibbles and would
// reject otherwise-valid ids like the dev actor 00000000-…-0001). These are just
// equality filters against uuid columns; the goal is "won't throw 22P02", not
// "is a canonically versioned UUID".
const uuidLike = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a UUID",
  );

// Query string for GET /audit (contract §8): optional filters + pagination.
export const auditQuerySchema = z.object({
  actorId: uuidLike.optional(),
  action: z.enum(Object.values(AuditAction)).optional(),
  targetType: z.enum(Object.values(TargetType)).optional(),
  targetId: uuidLike.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
