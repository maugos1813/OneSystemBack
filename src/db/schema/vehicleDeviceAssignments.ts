import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { devices } from "./devices.js";
import { vehicles } from "./vehicles.js";

/**
 * Which device a vehicle carried, and when. Positions belong to the device that recorded them, so this is what lets a vehicle's history
 * follow the vehicle: its route is what each device it had recorded while it was on it, and nothing of what that device did elsewhere.
 * Kept by a trigger on `vehicles.device_id` (migration 0040), so every way of changing the device is recorded the same.
 */
export const vehicleDeviceAssignments = pgTable(
  "vehicle_device_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** When the vehicle started carrying it. The assignments that existed before this record was kept start at the epoch: all of the device's history. */
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull().defaultNow(),
    /** Null while it still carries it. */
    toTs: timestamp("to_ts", { withTimezone: true }),
  },
  (table) => [
    index("vehicle_device_assignments_vehicle_idx").on(table.vehicleId, table.fromTs),
    index("vehicle_device_assignments_device_idx").on(table.deviceId),
    // A vehicle carries one device at a time, and a device is on one vehicle at a time.
    uniqueIndex("vehicle_device_assignments_open_vehicle").on(table.vehicleId).where(sql`${table.toTs} is null`),
    uniqueIndex("vehicle_device_assignments_open_device").on(table.deviceId).where(sql`${table.toTs} is null`),
  ],
);

export type VehicleDeviceAssignment = typeof vehicleDeviceAssignments.$inferSelect;
