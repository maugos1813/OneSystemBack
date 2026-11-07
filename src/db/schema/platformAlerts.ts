import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { devices } from "./devices.js";
import { organizations } from "./organizations.js";

/**
 * OneSystec's own security alerts, across every client (see platformSecurity.ts). One row per episode of a condition
 * (a device unplugged, an unknown IMEI connecting) or per one-off event (an immobilizer order, a new user). `key` says
 * what it is about, so an open episode is found again on the next pass instead of being announced twice.
 */
export const platformAlerts = pgTable(
  "platform_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** e.g. "unplug:<deviceId>", "immobilizer:<commandId>", "login_failed:<email>:<day>". */
    key: varchar("key", { length: 160 }).notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    /** "urgent": push + email now. "digest": in the daily email only. */
    severity: varchar("severity", { length: 10 }).notNull(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    /** Who it is about, as shown: "Cliente · vehículo". */
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    /** How many times it happened (failed sign-ins of one account in a day). */
    count: integer("count").notNull().default(1),
    firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null until it has been announced; a reminder moves it forward. */
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    /** When it last went out in the daily email. */
    digestedAt: timestamp("digested_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // Only one open episode per key; closed ones pile up as history.
    uniqueIndex("platform_alerts_open_key").on(table.key).where(sql`${table.resolvedAt} is null`),
    index("platform_alerts_key_idx").on(table.key),
  ],
);

export type PlatformAlert = typeof platformAlerts.$inferSelect;
export type NewPlatformAlert = typeof platformAlerts.$inferInsert;
