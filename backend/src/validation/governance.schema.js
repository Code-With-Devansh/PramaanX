import { z } from "zod";
import {
  classification,
  role,
  poolType,
  sudoActionType,
  sudoStatus,
} from "../db/schema/enums.js";

// Loose UUID-shape check (copied from audit.schema.js): mirrors what Postgres's
// `uuid` type accepts rather than zod's strict .uuid(), so ids like the dev actor
// 00000000-…-0001 aren't rejected. Goal is "won't throw 22P02", not RFC-canonical.
const uuidLike = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a UUID",
  );

const roleEnum = z.enum(role.enumValues);
const classificationEnum = z.enum(classification.enumValues);
const poolTypeEnum = z.enum(poolType.enumValues);
const actionTypeEnum = z.enum(sudoActionType.enumValues);
const statusEnum = z.enum(sudoStatus.enumValues);

// :id path param (a proposal id).
export const idParamSchema = uuidLike;

// Coarse payload shape. The action-specific required-field checks live in the
// SUDO_ACTIONS registry (src/governance/sudoActions.js) and are re-run in the
// service; here we only constrain the *types* of the known fields and strip the
// rest (zod objects strip unknown keys by default).
const payloadSchema = z.object({
  org: uuidLike.optional(),
  userId: uuidLike.optional(),
  poolType: poolTypeEnum.optional(),
  k: z.number().int().optional(),
  // m + members carry the roster for ONBOARD_ORG / POOL_REINSTATEMENT.
  m: z.number().int().optional(),
  members: z.array(uuidLike).min(1).optional(),
  // policy is the CHANGE_ABAC_POLICY override document. It must survive key
  // stripping (its inner shape is arbitrary), so it is a passthrough record; the
  // top-level-key + type guard lives in the registry validatePayload.
  policy: z.record(z.string(), z.any()).optional(),
});

export const fileProposalSchema = z.object({
  actionType: actionTypeEnum,
  payload: payloadSchema,
});

export const objectSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export const listProposalsSchema = z.object({
  status: statusEnum.optional(),
  actionType: actionTypeEnum.optional(),
  org: uuidLike.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ── bootstrap (genesis ceremony) ──────────────────────────────────────────────
// roster: founding users to create/link; pools: pools to create with their member
// emails (m = members.length); shares: genesis-share METADATA only (never secrets).
//
// org/jurisdiction here are plain NAMES, not FK ids — at genesis time the
// orgs/jurisdictions tables are necessarily empty (nothing exists yet to
// reference, and the only way to populate them, reference:manage, requires an
// admin who doesn't exist yet either). bootstrap()/regenesis() resolve these
// names to real rows (find-or-create, inside the ceremony transaction) before
// inserting the roster users. Every other entry point (provisionUser) requires
// a real orgId/jurisdictionId, since by then the lookup tables are populated.
const rosterEntrySchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).transform((v) => v.toLowerCase()),
  role: roleEnum,
  org: z.string().trim().min(1).max(200),
  clearance: classificationEnum,
  jurisdiction: z.string().trim().min(1).max(200),
  badgeId: z.string().trim().max(100).optional(),
  username: z.string().trim().min(1).max(60).optional(),
});

const poolSpecSchema = z.object({
  poolType: poolTypeEnum,
  // Same genesis exception as rosterEntrySchema.org — a plain name resolved
  // find-or-create inside the ceremony tx, not an FK id.
  org: z.string().trim().min(1).max(200).optional(),
  k: z.number().int().min(2).optional(),
  members: z.array(z.string().trim().email().transform((v) => v.toLowerCase())).min(1),
});

const shareSchema = z.object({
  holderLabel: z.string().trim().min(1).max(200),
  isColdStored: z.boolean().optional(),
});

export const bootstrapSchema = z.object({
  secret: z.string().min(1),
  roster: z.array(rosterEntrySchema).min(1),
  pools: z.array(poolSpecSchema).min(1),
  shares: z.array(shareSchema).optional(),
});

// ── regenesis (Tier-3 re-ceremony) ────────────────────────────────────────────
// Same roster/pool shape as bootstrap but no shares (share metadata is untouched)
// and pools are constrained to the two org-less top-tier types in the service.
export const regenesisSchema = z.object({
  secret: z.string().min(1),
  roster: z.array(rosterEntrySchema).min(1),
  pools: z.array(poolSpecSchema).min(1),
});
