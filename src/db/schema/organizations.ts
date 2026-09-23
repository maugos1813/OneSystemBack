import { jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  plan: varchar("plan", { length: 50 }).notNull().default("free"),
  /** Working hours + alert thresholds — see settings.service.ts for the shape and
   * defaults. Stored as a partial object; missing fields fall back to defaults on read,
   * so the shape can grow without a migration for every new preference. */
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
