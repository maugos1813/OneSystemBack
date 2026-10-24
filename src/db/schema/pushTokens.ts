import { index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/** A phone (or browser) that signed in and agreed to receive notifications: the FCM token to reach it. */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** FCM registration token; one per app install, and the same install signing in as someone else moves it to them. */
    token: text("token").notNull().unique(),
    platform: varchar("platform", { length: 20 }).notNull().default("android"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("push_tokens_user_idx").on(table.userId)],
);

export type PushToken = typeof pushTokens.$inferSelect;
