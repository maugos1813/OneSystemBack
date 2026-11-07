import { jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  /** The client's logo as a data URL (see orgLogo.ts), shown in the top bar. Null until they upload one. */
  logo: text("logo"),
  /** A small copy of the logo (a few KB) made when it was uploaded: what opens each plate on OneSystec's map. Null: the map uses `logo`. */
  logoTag: text("logo_tag"),
  plan: varchar("plan", { length: 50 }).notNull().default("free"),
  /** Working hours + alert thresholds — see settings.service.ts for the shape and
   * defaults. Stored as a partial object; missing fields fall back to defaults on read,
   * so the shape can grow without a migration for every new preference. */
  settings: jsonb("settings").notNull().default({}),
  /** The sections of OneTrack this client may have at all, set by OneSystec (see modules.ts). Null: no limit, everything. A client's
   * account holder and admins get exactly these; its other users get what they were given, within them. */
  modules: text("modules").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
