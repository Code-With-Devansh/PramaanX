import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./users.js";

export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("refresh_tokens_token_hash_key").on(t.tokenHash),
		index("refresh_tokens_user_id_idx").on(t.userId),
	],
);

