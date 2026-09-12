import { z } from "zod";

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentCommentId: z.string().uuid().optional(),
});

export const editCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});
