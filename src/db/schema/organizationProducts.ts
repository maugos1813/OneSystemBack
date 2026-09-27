import { relations } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Which non-default products (beyond "gps") a portal card should show for an org. */
export const organizationProducts = pgTable(
  "organization_products",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productKey: text("product_key").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.productKey] })],
);

export const organizationProductsRelations = relations(organizationProducts, ({ one }) => ({
  organization: one(organizations, { fields: [organizationProducts.orgId], references: [organizations.id] }),
}));

export type OrganizationProduct = typeof organizationProducts.$inferSelect;
export type NewOrganizationProduct = typeof organizationProducts.$inferInsert;
