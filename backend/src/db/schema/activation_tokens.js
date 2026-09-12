import {
    pgTable,
    uuid,
    text,
    boolean,
    timestamp,
    index,
} from "drizzle-orm/pg-core";


export const activation_tokens = pgTable(
    "activation_tokens",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id").notNull(),
        token: text("token").notNull().unique(),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        used: boolean("used").notNull().default(false),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
    },
    (t) => [
        index("user_id_idx").on(t.userId),
        index("token_idx").on(t.token),
    ]
);

