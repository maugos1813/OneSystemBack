import { relations } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Per-user restriction of which products a "viewer" teammate can see, on top of
 * whatever the organization already has enabled (organization_products). Only
 * meaningful for role "viewer" — "owner"/"admin" always see everything the org
 * has, so this table is ignored for them (see product.service.ts).
 */
export const userProducts = pgTable(
  "user_products",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productKey: text("product_key").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.productKey] })],
);

export const userProductsRelations = relations(userProducts, ({ one }) => ({
  user: one(users, { fields: [userProducts.userId], references: [users.id] }),
}));

export type UserProduct = typeof userProducts.$inferSelect;
export type NewUserProduct = typeof userProducts.$inferInsert;
