import { z } from "zod";

export const createReferenceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});

export const updateReferenceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const listReferenceSchema = z.object({
  activeOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
