import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { devices } from "./devices.js";
import { organizations } from "./organizations.js";

/**
 * The SIM card inside a tracker, as printed on the card the operator ships (ICCID, phone
 * number, NMU, PIN, PUK). `deviceId` is optional: a SIM can sit in stock before it goes
 * into a device. PIN/PUK are credentials — they are never part of list responses (see
 * sim.service.ts), only of the explicit owner/admin "secrets" read.
 */
export const simCards = pgTable(
  "sim_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    operator: varchar("operator", { length: 50 }).notNull().default("TIM"),
    /** Normalized (digits, plus the operator's letter suffix after a dash, e.g. "…067-K48H"). */
    iccid: varchar("iccid", { length: 32 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 20 }),
    nmu: varchar("nmu", { length: 20 }),
    pin: varchar("pin", { length: 8 }),
    puk: varchar("puk", { length: 12 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sim_cards_org_iccid_unique").on(table.orgId, table.iccid),
    // one SIM per tracker (Postgres lets any number of SIMs in stock, with no device, share NULL)
    uniqueIndex("sim_cards_device_unique").on(table.deviceId),
  ],
);

export const simCardsRelations = relations(simCards, ({ one }) => ({
  organization: one(organizations, { fields: [simCards.orgId], references: [organizations.id] }),
  device: one(devices, { fields: [simCards.deviceId], references: [devices.id] }),
}));

export type SimCard = typeof simCards.$inferSelect;
export type NewSimCard = typeof simCards.$inferInsert;
