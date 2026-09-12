import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";


import { classification, role, status } from "./enums.js"
import { orgs, jurisdictions } from "./reference.js";


// users table schema definition for Drizzle ORM as given in docs/contract.md
export const users = pgTable(
  "users",
  {
    // user summary information
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    role: role("role").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "restrict" }),
    badgeId: text("badge_id"),
    
    
    email: text("email").notNull().unique(),
    clearance: classification("clearance").notNull(),
    jurisdictionId: uuid("jurisdiction_id")
      .notNull()
      .references(() => jurisdictions.id, { onDelete: "restrict" }),
    status: status("status").notNull(),
    
    // mfa secrets and backup codes so that we can verify the user during login
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    mfaTempSecret: text("mfa_temp_secret"),
    mfaSecret: text("mfa_secret"),

    // backup codes are stored as a JSON array of objects with the following structure:
    // {
    //   codeHash: string, // hashed backup code
    //   used: boolean, // whether the code has been used
    // }

    backupCodes: text("backup_codes"),

    // timestamps for auditing and security purposes
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    
    // username and hashed password for authentication
    username: text("username").notNull().unique(), // created to uniquely identify users, not necessarily their email address
    hashedPassword: text("hashed_password").notNull(),
  },
  (t) => [

    // creating indexes for faster queries on frequently accessed columns
    // as per the requirements of the application in user repository and user service
    index("username_idx").on(t.username),
    index("org_idx").on(t.orgId),
    index("jurisdiction_idx").on(t.jurisdictionId),
    index("role_idx").on(t.role),
    index("status_idx").on(t.status),
  ],
);
