import { relations } from "drizzle-orm";
import { doublePrecision, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { organizations } from "./organizations.js";

export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  plate: varchar("plate", { length: 20 }),
  // Which client contract this vehicle belongs to (e.g. "DHL", "UNIVEX") — only set for
  // vehicles synced from Radius Velocity, which groups devices this way.
  fleetGroup: varchar("fleet_group", { length: 50 }),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
  // Added to the tracker's odometer to get the dashboard reading (a tracker counts from its
  // own install, not from the car's real km). Set when someone calibrates it for maintenance.
  odometerOffsetKm: integer("odometer_offset_km").notNull().default(0),
  // The vehicle's profile ("perfil"): what it is, beyond its name, plate and device.
  brand: varchar("brand", { length: 50 }),
  model: varchar("model", { length: 50 }),
  year: integer("year"),
  /** Chassis number (telaio). */
  vin: varchar("vin", { length: 30 }),
  fuelType: varchar("fuel_type", { length: 20 }),
  color: varchar("color", { length: 30 }),
  notes: text("notes"),
  // Its current km. "auto": counted by itself (the car's odometer when the tracker reads it, otherwise the km typed at
  // odometerBaseAt plus what the GPS counted after that day). "manual": exactly the km typed, until someone changes it.
  odometerMode: varchar("odometer_mode", { length: 10 }).notNull().default("auto"),
  odometerBaseKm: integer("odometer_base_km"),
  odometerBaseAt: timestamp("odometer_base_at", { withTimezone: true }),
  // What the GPS count is multiplied by to match the dashboard: straight lines between reports cut corners, so a vehicle
  // counted by GPS reads a little low. Learned when someone types the dashboard km again (1 = not learned yet).
  kmFactor: doublePrecision("km_factor").notNull().default(1),
  kmFactorAt: timestamp("km_factor_at", { withTimezone: true }),
  // The GPS km driven on the day the dashboard km were typed, after the moment they were typed (the day's daily total
  // also holds the km before it, which the reading already includes). Kept once that day is over, while the positions that
  // say it are still stored; until then it is worked out live.
  odometerBaseDayKm: doublePrecision("odometer_base_day_km"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vehiclesRelations = relations(vehicles, ({ one }) => ({
  organization: one(organizations, { fields: [vehicles.orgId], references: [organizations.id] }),
  device: one(devices, { fields: [vehicles.deviceId], references: [devices.id] }),
}));

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
