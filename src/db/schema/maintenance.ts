import { relations } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { vehicles } from "./vehicles.js";

/**
 * A recurring service of a vehicle ("cambio de aceite" every 15 000 km or 12 months,
 * whichever comes first). `lastDoneAt` / `lastDoneKm` are the baseline the next due point
 * is counted from — they move forward each time a service is registered. At least one of
 * `intervalKm` / `intervalMonths` is set (enforced by the API, not the table).
 * Kilometres are on the vehicle's corrected odometer (tracker reading + the vehicle's offset).
 */
export const maintenancePlans = pgTable(
  "maintenance_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    intervalKm: integer("interval_km"),
    intervalMonths: integer("interval_months"),
    lastDoneAt: timestamp("last_done_at", { withTimezone: true }),
    lastDoneKm: integer("last_done_km"),
    /** Km driven since the last service that the GPS count could not see (the service was before it started counting,
     * or the person corrected it against the dashboard). Added to the GPS kilometres; 0 when there is nothing to add. */
    kmAdjust: integer("km_adjust").notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("maintenance_plans_org_vehicle_idx").on(table.orgId, table.vehicleId)],
);

/** One time a plan's service was actually done — the history behind `lastDoneAt`. */
export const maintenanceRecords = pgTable(
  "maintenance_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => maintenancePlans.id, { onDelete: "cascade" }),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull(),
    odometerKm: integer("odometer_km"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("maintenance_records_plan_idx").on(table.planId, table.doneAt)],
);

export const maintenancePlansRelations = relations(maintenancePlans, ({ one, many }) => ({
  vehicle: one(vehicles, { fields: [maintenancePlans.vehicleId], references: [vehicles.id] }),
  records: many(maintenanceRecords),
}));

export const maintenanceRecordsRelations = relations(maintenanceRecords, ({ one }) => ({
  plan: one(maintenancePlans, { fields: [maintenanceRecords.planId], references: [maintenancePlans.id] }),
}));

export type MaintenancePlan = typeof maintenancePlans.$inferSelect;
export type NewMaintenancePlan = typeof maintenancePlans.$inferInsert;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;
