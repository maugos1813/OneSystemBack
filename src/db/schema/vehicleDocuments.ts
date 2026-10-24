import { date, index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { vehicles } from "./vehicles.js";

/**
 * A document of a vehicle that expires (seguro, revisione, bollo, tacógrafo…), so its owner is warned before it does.
 * `kind` is one of DOCUMENT_KINDS (services/vehicleDocuments.ts); "otro" uses `label` for its name.
 */
export const vehicleDocuments = pgTable(
  "vehicle_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 30 }).notNull(),
    label: varchar("label", { length: 100 }),
    /** The day it expires, as a calendar date with no time zone. */
    expiresOn: date("expires_on", { mode: "string" }).notNull(),
    /** How many days before expiring it starts to warn. */
    remindDays: integer("remind_days").notNull().default(30),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("vehicle_documents_org_vehicle_idx").on(table.orgId, table.vehicleId)],
);

export type VehicleDocument = typeof vehicleDocuments.$inferSelect;
