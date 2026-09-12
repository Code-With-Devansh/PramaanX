import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../config/db.js";
import * as schema from "./schema/index.js";

// The Drizzle query client, backed by the existing node-postgres pool.
// Import { db } from here in repositories/services.
export const db = drizzle(pool, { schema });
