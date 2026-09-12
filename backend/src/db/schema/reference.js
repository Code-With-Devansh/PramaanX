import { pgTable, uuid, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";

// Reference/lookup tables for what used to be free-text fields elsewhere: org
// (users.org_id, admin_pools.org_id, sudo_proposals.org_id) and jurisdiction
// (users.jurisdiction_id, cases.jurisdiction_id). Both are simple admin-managed
// lookups (RBAC-gated, not quorum-gated — see src/services/reference.service.js).
// `id` is now a real FK target for those columns; `active` lets an admin retire a
// value going forward without breaking historical rows that still reference it —
// deleting/renaming a row that's still referenced is blocked by the FK / by
// reference.service.js's usage check respectively.

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("orgs_name_key").on(t.name)],
);

export const jurisdictions = pgTable(
  "jurisdictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("jurisdictions_name_key").on(t.name)],
);
