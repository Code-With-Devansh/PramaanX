import { z } from "zod";
import { caseStatus, classification } from "../db/schema/enums.js";

const idSchema = z.string().uuid();
const classificationEnum = z.enum(classification.enumValues);
const caseStatusEnum = z.enum(caseStatus.enumValues);

export const createCaseSchema = z.object({
  caseNumber: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  type: z.string().trim().min(1).max(100),
  classification: classificationEnum,
  jurisdictionId: z.string().uuid(),
  description: z.string().trim().max(5000).optional(),
});

export const updateCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    status: caseStatusEnum.optional(),
    classification: classificationEnum.optional(),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one case field is required",
  });

export const listCasesSchema = z.object({
  status: caseStatusEnum.optional(),
  q: z.string().trim().max(200).optional(),
  assignedToMe: z
    .preprocess((value) => value === "true", z.boolean())
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const assignOfficerSchema = z.object({
  userId: idSchema,
  roleOnCase: z.string().trim().min(1).max(100),
});

export const legalHoldSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export { idSchema };
