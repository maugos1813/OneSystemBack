import { relations } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";

/**
 * Discrete events derived from IO elements worth tracking on their own (ignition
 * toggles, alarms, towing, jamming, ...), separate from the raw position stream.
 */
export const deviceEvents = pgTable(
  "device_events",
  {
    id: uuid("id").defaultRandom().notNull(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.id, table.ts] })],
);

export const deviceEventsRelations = relations(deviceEvents, ({ one }) => ({
  device: one(devices, { fields: [deviceEvents.deviceId], references: [devices.id] }),
}));

export type DeviceEvent = typeof deviceEvents.$inferSelect;
export type NewDeviceEvent = typeof deviceEvents.$inferInsert;
