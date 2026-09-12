import { authorize } from "../lib/authorize.js";
import { parse } from "../lib/validate.js";
import {
  createReferenceSchema,
  updateReferenceSchema,
  listReferenceSchema,
} from "../validation/reference.schema.js";
import { orgService, jurisdictionService } from "../services/reference.service.js";

function makeController(service) {
  return {
    async list(req, res) {
      await authorize({ user: req.user, action: "reference:read" });
      const filters = parse(listReferenceSchema, req.query);
      res.json(await service.list(filters));
    },

    async get(req, res) {
      await authorize({ user: req.user, action: "reference:read" });
      res.json(await service.get(req.params.id));
    },

    async create(req, res) {
      await authorize({ user: req.user, action: "reference:manage" });
      const values = parse(createReferenceSchema, req.body);
      res.status(201).json(await service.create(values));
    },

    async update(req, res) {
      await authorize({ user: req.user, action: "reference:manage" });
      const values = parse(updateReferenceSchema, req.body);
      res.json(await service.update(req.params.id, values));
    },

    async remove(req, res) {
      await authorize({ user: req.user, action: "reference:manage" });
      await service.remove(req.params.id);
      res.status(204).send();
    },
  };
}

export const orgs = makeController(orgService);
export const jurisdictions = makeController(jurisdictionService);
