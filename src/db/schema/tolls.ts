import { relations } from "drizzle-orm";
import { boolean, doublePrecision, index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { vehicles } from "./vehicles.js";

/**
 * Toll barriers/gantries, seeded once from OpenStreetMap (see scripts/seedTollPlazas.ts) —
 * global reference data, not per-organization. One row per physical station: the several
 * lane nodes OSM draws for it are clustered into a single point at seed time.
 */
export const tollPlazas = pgTable("toll_plazas", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Stable key (lowest OSM node id of the cluster) so re-running the seed updates in place. */
  osmKey: varchar("osm_key", { length: 30 }).notNull().unique(),
  name: varchar("name", { length: 150 }).notNull(),
  operator: varchar("operator", { length: 150 }),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  /** The physical gates/lanes ([lat, lng] each) the station was clustered from. Detection
   * measures against these, not the centroid, so a vehicle on a nearby mainline that never
   * enters the station isn't counted as a pass. */
  points: jsonb("points").$type<Array<[number, number]>>().notNull().default([]),
});

/** One row per detected pass of a vehicle through a toll station. */
export const tollPassages = pgTable(
  "toll_passages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    plazaId: uuid("plaza_id")
      .notNull()
      .references(() => tollPlazas.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    /** Marked by the org as an unauthorized use of the toll. */
    flagged: boolean("flagged").notNull().default(false),
    /** A GPS report near the gates showed the vehicle slowed down through them. false = reports
     * near the station were too sparse to tell a real pass from a mainline running past it. */
    confirmed: boolean("confirmed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("toll_passages_org_ts_idx").on(table.orgId, table.ts.desc()),
    index("toll_passages_vehicle_plaza_ts_idx").on(table.vehicleId, table.plazaId, table.ts.desc()),
  ],
);

export const tollPassagesRelations = relations(tollPassages, ({ one }) => ({
  vehicle: one(vehicles, { fields: [tollPassages.vehicleId], references: [vehicles.id] }),
  plaza: one(tollPlazas, { fields: [tollPassages.plazaId], references: [tollPlazas.id] }),
}));

export type TollPlaza = typeof tollPlazas.$inferSelect;
export type TollPassage = typeof tollPassages.$inferSelect;
