import { defineConfig } from "drizzle-kit";

// Single Drizzle project for the whole backend: teammates add their domain
// schema files under src/db/schema/ and re-run `npm run db:generate`.
//
// `generate` runs offline (no DB connection); `migrate`/`push`/`studio` read
// DATABASE_URL from the environment (provided by docker-compose, or your shell).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.js",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL },
});
