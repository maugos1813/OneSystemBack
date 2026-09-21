import { relations } from "drizzle-orm";
import { pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const deviceStatusEnum = pgEnum("device_status", ["unclaimed", "active", "disabled"]);

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Nullable until a user claims the device into their organization.
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  imei: varchar("imei", { length: 20 }).notNull().unique(),
  model: varchar("model", { length: 50 }).notNull().default("FMB204"),
  status: deviceStatusEnum("status").notNull().default("unclaimed"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const devicesRelations = relations(devices, ({ one }) => ({
  organization: one(organizations, { fields: [devices.orgId], references: [organizations.id] }),
}));

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
