import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, jurisdictions, users, cases, adminPools, sudoProposals } from "../db/schema/index.js";

// Shared CRUD for the two lookup tables (orgs, jurisdictions). Both tables have
// an identical shape (id, name, description, active, timestamps), so one
// parameterized repository backs both rather than duplicating the same
// queries twice.
//
// usageColumns lists every column elsewhere in the schema that FKs to this
// table's id — used only for a friendly pre-check message on delete; the FK's
// ON DELETE RESTRICT is the actual enforcement, so this can never go stale
// silently (a forgotten entry here just means a plain DB error instead of a
// nicer one).
function makeRepository(table, usageColumns) {
  return {
    async list({ activeOnly = false } = {}) {
      const query = db.select().from(table).orderBy(asc(table.name));
      if (activeOnly) return query.where(eq(table.active, true));
      return query;
    },

    async findById(id) {
      const [row] = await db.select().from(table).where(eq(table.id, id)).limit(1);
      return row ?? null;
    },

    async findByName(name) {
      const [row] = await db.select().from(table).where(eq(table.name, name)).limit(1);
      return row ?? null;
    },

    async create(values) {
      const [row] = await db.insert(table).values(values).returning();
      return row;
    },

    async update(id, values) {
      const [row] = await db
        .update(table)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(table.id, id))
        .returning();
      return row ?? null;
    },

    async remove(id) {
      const [row] = await db.delete(table).where(eq(table.id, id)).returning();
      return row ?? null;
    },

    // Reference count across every FK'd table — used to give a friendly 409
    // before the DB's ON DELETE RESTRICT would reject the delete anyway.
    async countUsages(id) {
      const counts = await Promise.all(
        usageColumns.map(async ({ table: t, column }) => {
          const rows = await db.select().from(t).where(eq(column, id));
          return rows.length;
        }),
      );
      return counts.reduce((a, b) => a + b, 0);
    },
  };
}

export const orgRepository = makeRepository(orgs, [
  { table: users, column: users.orgId },
  { table: adminPools, column: adminPools.orgId },
  { table: sudoProposals, column: sudoProposals.orgId },
]);

export const jurisdictionRepository = makeRepository(jurisdictions, [
  { table: users, column: users.jurisdictionId },
  { table: cases, column: cases.jurisdictionId },
]);
