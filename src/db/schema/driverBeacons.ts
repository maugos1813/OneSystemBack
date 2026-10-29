import { pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * A Bluetooth beacon (Teltonika EYE Beacon) a driver carries. The tracker in the vehicle reports the beacons it hears;
 * this table says whose each one is. `beaconId` is the key services/beaconParser.ts builds from what the tracker
 * reports ("eddystone:<namespace>-<instance>" or "ibeacon:<uuid>-<major>-<minor>", lower-case hex).
 */
export const driverBeacons = pgTable(
  "driver_beacons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    beaconId: varchar("beacon_id", { length: 100 }).notNull(),
    driverName: varchar("driver_name", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("driver_beacons_org_beacon_unique").on(table.orgId, table.beaconId)],
);

export type DriverBeacon = typeof driverBeacons.$inferSelect;
