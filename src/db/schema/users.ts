import { relations } from "drizzle-orm";
import { pgEnum, pgTable, timestamp, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

// "manager": a delegated sub-admin — can invite/edit/remove only the sub-users it
// created itself (users.parentUserId pointing back at it), never the rest of the org's
// team. Its own view can be restricted by allowedArea/userProducts just like a viewer's.
export const userRoleEnum = pgEnum("user_role", ["owner", "admin", "manager", "viewer"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull().default(""),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull().default("viewer"),
  // Set only for a sub-user created by a "manager" — points at that manager. Null for
  // everyone else (owner/admin/manager/top-level viewers invited by the org itself).
  parentUserId: uuid("parent_user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }),
  // Hard access restriction to one client-contract área (e.g. "DHL"/"UNIVEX", matching
  // vehicles.fleetGroup) — enforced server-side on every vehicle/device/position read,
  // not just a UI default. Null means unrestricted (sees every área the org has).
  allowedArea: varchar("allowed_area", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
  parent: one(users, { fields: [users.parentUserId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
