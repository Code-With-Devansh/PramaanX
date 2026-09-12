import { z } from "zod";
import { classification, role, status } from "../db/schema/enums.js";
import { idSchema } from "./cases.schema.js";

const roleEnum = z.enum(role.enumValues);
const statusEnum = z.enum(status.enumValues);
const classificationEnum = z.enum(classification.enumValues);

export const listUsersSchema = z.object({
  role: roleEnum.optional(),
  orgId: z.string().uuid().optional(),
  status: statusEnum.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const provisionUserSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: roleEnum,
  clearance: classificationEnum,
  jurisdictionId: z.string().uuid(),
  orgId: z.string().uuid(),
  badgeId: z.string().trim().max(100).optional(),
});

export const updateUserSchema = z.object({
  role: roleEnum.optional(),
  clearance: classificationEnum.optional(),
  jurisdictionId: z.string().uuid().optional(),
  status: statusEnum.optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "at least one user field is required" });

export { idSchema };