import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const notifications = pgTable(
	"notifications",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		type: text("type").notNull(),
		message: text("message").notNull(),
		link: text("link"),
		read: boolean("read").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

		
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
	},
	(t) => [
		index("notifications_user_created_at_idx").on(t.userId, t.createdAt),
		index("notifications_user_unread_idx").on(t.userId, t.read),
	],
);


