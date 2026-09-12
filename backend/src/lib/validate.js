import { badRequest } from "./errors.js";

// Validate `data` against a zod schema, throwing a 400 ApiError (with the zod
// issues in `details`) on failure. Shared by controllers.
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest("validation failed", result.error.issues);
  return result.data;
}
