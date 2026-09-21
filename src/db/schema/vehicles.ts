import { relations } from "drizzle-orm";
import { pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { organizations } from "./organizations.js";

export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  plate: varchar("plate", { length: 20 }),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const vehiclesRelations = relations(vehicles, ({ one }) => ({
  organization: one(organizations, { fields: [vehicles.orgId], references: [organizations.id] }),
  device: one(devices, { fields: [vehicles.deviceId], references: [devices.id] }),
}));

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
