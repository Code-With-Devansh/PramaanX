import {
	pgTable,
	uuid,
	text,
	boolean,
	timestamp,
	index,
	unique,
} from "drizzle-orm/pg-core";

import { caseStatus, classification } from "./enums.js";
import { users } from "./users.js";
import { jurisdictions } from "./reference.js";

export const cases = pgTable(
	"cases",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		caseNumber: text("case_number").notNull(),
		title: text("title").notNull(),
		type: text("type").notNull(),
		status: caseStatus("status").notNull().default("OPEN"),
		classification: classification("classification").notNull(),
		jurisdictionId: uuid("jurisdiction_id")
			.notNull()
			.references(() => jurisdictions.id, { onDelete: "restrict" }),
		description: text("description"),
		createdBy: uuid("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		legalHold: boolean("legal_hold").notNull().default(false),
		legalHoldReason: text("legal_hold_reason"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("cases_case_number_key").on(t.caseNumber),
		index("cases_status_idx").on(t.status),
		index("cases_classification_idx").on(t.classification),
		index("cases_jurisdiction_idx").on(t.jurisdictionId),
		index("cases_created_by_idx").on(t.createdBy),
		index("cases_updated_at_idx").on(t.updatedAt),
	],
);

export const caseOfficers = pgTable(
	"case_assignments",
	{
		caseId: uuid("case_id")
			.notNull()
			.references(() => cases.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		roleOnCase: text("role_on_case").notNull(),
		assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
        assignedBy: uuid("assigned_by")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),

	},
	(t) => [
		unique("case_assignments_case_id_user_id_key").on(t.caseId, t.userId),
		index("case_assignments_case_id_idx").on(t.caseId),
		index("case_assignments_user_id_idx").on(t.userId),
		index("case_assignments_role_on_case_idx").on(t.roleOnCase),
	],
);

