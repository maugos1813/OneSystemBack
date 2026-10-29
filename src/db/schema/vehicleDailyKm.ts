import { date, doublePrecision, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { vehicles } from "./vehicles.js";

/**
 * How far each vehicle drove each day (Rome calendar day), added up from its GPS positions. Positions are pruned
 * (Radius Velocity routes after 7 days, the rest after 3 months), this is the small permanent record the maintenance
 * plans count their kilometres from. Written by services/dailyKm.service.ts.
 */
export const vehicleDailyKm = pgTable(
  "vehicle_daily_km",
  {
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    km: doublePrecision("km").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.vehicleId, table.day] })],
);

export type VehicleDailyKm = typeof vehicleDailyKm.$inferSelect;
