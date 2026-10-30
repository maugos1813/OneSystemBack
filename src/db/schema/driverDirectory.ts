import { boolean, index, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * What Gamonal Driver says about its drivers and who used which vehicle, copied here (services/driverDirectory.service.ts)
 * so the map and the history do not depend on the Driver being up. The Driver stays the source of truth: both tables are
 * only a cache that the sync rewrites, never edited from OneSystec.
 */
export const driverPeople = pgTable(
  "driver_people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The driver's id in Gamonal Driver. */
    externalId: varchar("external_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    phone: varchar("phone", { length: 40 }),
    active: boolean("active").notNull().default(true),
    /** Plate of the vehicle the Driver gives them as their usual one. */
    habitualPlate: varchar("habitual_plate", { length: 20 }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("driver_people_org_external_unique").on(table.orgId, table.externalId)],
);

/** One service of the Driver: this driver had this vehicle from `startsAt` to `endsAt`. */
export const driverUsages = pgTable(
  "driver_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The service's id in Gamonal Driver. */
    externalId: varchar("external_id", { length: 64 }).notNull(),
    driverExternalId: varchar("driver_external_id", { length: 64 }).notNull(),
    /** Upper-case, no spaces: how vehicles.plate is matched. */
    plate: varchar("plate", { length: 20 }).notNull(),
    /** The van the service ended with when the driver switched halfway (the time of the switch is not known). */
    finalPlate: varchar("final_plate", { length: 20 }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Null when the Driver has no end time for it. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** true: the hours the driver declared; false: the estimate from the departure and the ETA. */
    declared: boolean("declared").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("driver_usages_org_external_unique").on(table.orgId, table.externalId),
    index("driver_usages_plate_idx").on(table.orgId, table.plate, table.startsAt),
  ],
);

export type DriverPerson = typeof driverPeople.$inferSelect;
export type DriverUsage = typeof driverUsages.$inferSelect;
