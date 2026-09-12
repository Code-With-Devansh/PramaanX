import { z } from "zod";

export const notificationIdSchema = z.string().uuid();

export const notificationPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});