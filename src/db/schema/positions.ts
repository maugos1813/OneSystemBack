import { relations } from "drizzle-orm";
import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { devices } from "./devices.js";

/**
 * Time-series table of AVL records decoded from the device's Codec 8 / Codec 8 Extended
 * packets. Turned into a TimescaleDB hypertable (partitioned on `ts`) by the
 * hand-written follow-up migration — see drizzle/0001_timescale_postgis.sql.
 * A generated PostGIS `geography(Point,4326)` column is added by that same migration
 * for spatial queries (nearby/within-geofence); ordinary reads/writes just use lat/lng.
 *
 * The primary key includes `ts` because TimescaleDB requires the partitioning column
 * to be part of every unique constraint on a hypertable.
 */
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").defaultRandom().notNull(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    altitude: integer("altitude").notNull(),
    angle: integer("angle").notNull(),
    satellites: smallint("satellites").notNull(),
    speed: integer("speed").notNull(),
    priority: smallint("priority").notNull(),
    /** Raw decoded IO elements keyed by AVL ID, e.g. { "239": 1, "66": 24079 }. */
    ioData: jsonb("io_data").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.ts] })],
);

export const positionsRelations = relations(positions, ({ one }) => ({
  device: one(devices, { fields: [positions.deviceId], references: [devices.id] }),
}));

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
