import { relations } from "drizzle-orm";
import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { vehicles } from "./vehicles.js";

/**
 * One row per "episode" of an ongoing alert condition (offline, low battery, speeding,
 * after-hours, excessive idling) — lets the background evaluator email once when it
 * starts instead of every time it re-checks, by looking for an open row (resolved_at
 * IS NULL) before sending. Momentary events (geofence enter/exit) don't need this table
 * at all, since they're inherently one-shot.
 */
export const alertNotifications = pgTable("alert_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  vehicleId: uuid("vehicle_id")
    .notNull()
    .references(() => vehicles.id, { onDelete: "cascade" }),
  alertType: varchar("alert_type", { length: 30 }).notNull(),
  firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true }).notNull().defaultNow(),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const alertNotificationsRelations = relations(alertNotifications, ({ one }) => ({
  organization: one(organizations, { fields: [alertNotifications.orgId], references: [organizations.id] }),
  vehicle: one(vehicles, { fields: [alertNotifications.vehicleId], references: [vehicles.id] }),
}));

export type AlertNotification = typeof alertNotifications.$inferSelect;
export type NewAlertNotification = typeof alertNotifications.$inferInsert;
