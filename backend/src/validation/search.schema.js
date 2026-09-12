import { z } from "zod";
import { classification, docType } from "../db/schema/enums.js";

const classificationEnum = z.enum(classification.enumValues);
const docTypeEnum = z.enum(docType.enumValues);

// GET /search query string. `q` is optional on its own (bare filters — e.g.
// "all EVIDENCE docs on this case" — are a valid search too), but at least one
// of q/caseId/docType/classification/tags must be present so this doesn't
// silently become "list every document I can see" through the search endpoint.
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    caseId: z.string().uuid().optional(),
    docType: docTypeEnum.optional(),
    classification: classificationEnum.optional(),
    tags: z
      .union([z.string(), z.array(z.string())])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => v.q || v.caseId || v.docType || v.classification || v.tags?.length, {
    message: "at least one of q, caseId, docType, classification, tags is required",
  });
