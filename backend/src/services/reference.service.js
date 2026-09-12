import { conflict, notFound } from "../lib/errors.js";
import { orgRepository, jurisdictionRepository } from "../repositories/reference.repository.js";

// Both orgs and jurisdictions are admin-managed lookups with an identical CRUD
// shape (see reference.repository.js). users.org_id / users.jurisdiction_id /
// cases.jurisdiction_id / admin_pools.org_id / sudo_proposals.org_id are real
// FKs to these tables' id (ON DELETE RESTRICT), so:
//   - renaming a value (`name`/`description`) is always safe and retroactive —
//     every referencing row follows the same id, no separate gate needed.
//   - deleting a value still in use is rejected. The FK is what actually
//     enforces this; countUsages here only produces a friendlier 409 instead
//     of a raw constraint-violation error. Deactivating (active=false) is the
//     way to retire a value without breaking existing references.
function makeService(repository, kind) {
  return {
    async list(filters) {
      return repository.list(filters);
    },

    async get(id) {
      const row = await repository.findById(id);
      if (!row) throw notFound(`${kind} not found`);
      return row;
    },

    async create(values) {
      const existing = await repository.findByName(values.name);
      if (existing) throw conflict(`${kind} '${values.name}' already exists`);
      return repository.create(values);
    },

    async update(id, values) {
      const row = await repository.findById(id);
      if (!row) throw notFound(`${kind} not found`);

      if (values.name && values.name !== row.name) {
        const existing = await repository.findByName(values.name);
        if (existing) throw conflict(`${kind} '${values.name}' already exists`);
      }

      return repository.update(id, values);
    },

    async remove(id) {
      const row = await repository.findById(id);
      if (!row) throw notFound(`${kind} not found`);

      const usages = await repository.countUsages(id);
      if (usages > 0) {
        throw conflict(
          `${kind} '${row.name}' is referenced by ${usages} existing record(s); deactivate it instead of deleting`,
          "IN_USE",
        );
      }

      return repository.remove(id);
    },
  };
}

export const orgService = makeService(orgRepository, "org");
export const jurisdictionService = makeService(jurisdictionRepository, "jurisdiction");
