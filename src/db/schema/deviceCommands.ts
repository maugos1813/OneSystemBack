import { index, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const deviceCommandKindEnum = pgEnum("device_command_kind", ["immobilize", "release"]);
// pending: waiting for the device to be connected · sent: written to its socket ·
// confirmed/failed: what the device answered · expired: never delivered in time · cancelled: replaced by a newer one.
export const deviceCommandStatusEnum = pgEnum("device_command_status", [
  "pending",
  "sent",
  "confirmed",
  "failed",
  "expired",
  "cancelled",
]);

/** A remote order to a tracker's output (vehicle immobilizer) — also the audit trail of who gave it. */
export const deviceCommands = pgTable(
  "device_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: deviceCommandKindEnum("kind").notNull(),
    /** The text sent to the device (Codec 12). */
    command: varchar("command", { length: 100 }).notNull(),
    status: deviceCommandStatusEnum("status").notNull().default("pending"),
    /** What the device answered, or why we gave up. */
    response: text("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** A command still undelivered after this is dropped, so an old order never fires by surprise. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (table) => [index("device_commands_device_idx").on(table.deviceId, table.createdAt)],
);

export type DeviceCommand = typeof deviceCommands.$inferSelect;
