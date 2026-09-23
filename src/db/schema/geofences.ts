import { relations } from "drizzle-orm";
import { boolean, doublePrecision, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Circular geofence: center + radius, the simplest shape that covers the common case
 * (a depot, a client site, an authorized work zone) without a polygon-drawing tool. */
export const geofences = pgTable("geofences", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  radiusMeters: integer("radius_meters").notNull(),
  alertOnEnter: boolean("alert_on_enter").notNull().default(true),
  alertOnExit: boolean("alert_on_exit").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const geofencesRelations = relations(geofences, ({ one }) => ({
  organization: one(organizations, { fields: [geofences.orgId], references: [organizations.id] }),
}));

export type Geofence = typeof geofences.$inferSelect;
export type NewGeofence = typeof geofences.$inferInsert;
