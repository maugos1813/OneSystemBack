import { relations } from "drizzle-orm";
import { boolean, doublePrecision, integer, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const geofenceTypeEnum = pgEnum("geofence_type", ["circle", "polygon"]);

/** A geofence point, as stored in `path`. */
export interface GeofencePoint {
  lat: number;
  lng: number;
}

/**
 * Two shapes: a circle (center + radius — the common case, e.g. a depot or client site,
 * with no polygon-drawing tool needed) or a polygon (a list of rings, so a single
 * geofence can also cover several disjoint areas — e.g. official zone boundaries like
 * Milan's Area B/Area C, which aren't circular). Exactly one of
 * (lat/lng/radiusMeters) or path is populated, matching `type`.
 */
export const geofences = pgTable("geofences", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  type: geofenceTypeEnum("type").notNull().default("circle"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  radiusMeters: integer("radius_meters"),
  path: jsonb("path").$type<GeofencePoint[][]>(),
  alertOnEnter: boolean("alert_on_enter").notNull().default(true),
  alertOnExit: boolean("alert_on_exit").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const geofencesRelations = relations(geofences, ({ one }) => ({
  organization: one(organizations, { fields: [geofences.orgId], references: [organizations.id] }),
}));

export type Geofence = typeof geofences.$inferSelect;
export type NewGeofence = typeof geofences.$inferInsert;
