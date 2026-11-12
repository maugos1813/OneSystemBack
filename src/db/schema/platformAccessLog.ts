import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Who of OneSystec went into which client's account, and what they changed there. A record is kept when a person opens a client's
 * account (read-only "view" or editable "manage") and for every change made while managing it ("write"). No foreign keys: the record
 * outlives a deleted person or client.
 */
export const platformAccessLog = pgTable(
  "platform_access_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    /** "view" | "manage" | "write" */
    action: varchar("action", { length: 10 }).notNull(),
    /** For a write: the method and route, e.g. "PATCH /vehicles/:id". */
    detail: varchar("detail", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("platform_access_log_org_idx").on(table.orgId, table.createdAt)],
);

export type PlatformAccessEntry = typeof platformAccessLog.$inferSelect;
