import { pgTable, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * What a client's fleet ("flota", e.g. DHL, UNIVEX) has beyond its name: the picture that opens its plates on the map. The name
 * is the same text as `vehicles.fleet_group` and `users.allowed_area`, so a fleet needs no row to exist: it has one only once it
 * has something to keep.
 */
export const fleets = pgTable(
  "fleets",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(),
    /** The fleet's picture as a data URL (see orgLogo.ts); null falls back to the letters. */
    logo: text("logo"),
  /** A small copy of the picture (a few KB) made when it was uploaded: what the map draws on each plate. Null: the map uses `logo`. */
  logoTag: text("logo_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.name] })],
);

export type Fleet = typeof fleets.$inferSelect;
