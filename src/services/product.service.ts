import { eq } from "drizzle-orm";
import { PRODUCT_CATALOG, type ProductCatalogEntry } from "../config/products.js";
import { db } from "../db/client.js";
import { organizationProducts, userProducts, type User } from "../db/schema/index.js";

/** The org-level ceiling: every product this organization has enabled at all. */
export async function getProductsForOrg(orgId: string): Promise<ProductCatalogEntry[]> {
  const rows = await db
    .select({ productKey: organizationProducts.productKey })
    .from(organizationProducts)
    .where(eq(organizationProducts.orgId, orgId));

  const enabledKeys = new Set(rows.map((row) => row.productKey));
  return PRODUCT_CATALOG.filter((product) => product.key === "gps" || enabledKeys.has(product.key));
}

/**
 * What this specific user should see: the org's ceiling, further narrowed for a
 * "viewer"/"manager" by whichever products an admin (or, for a manager's own
 * sub-users, the manager) has granted them (user_products). An "owner"/"admin" always
 * sees the full org ceiling — restricting teammates is their job to do to others, not
 * something applied to themselves.
 */
export async function getProductsForUser(orgId: string, userId: string, role: User["role"]): Promise<ProductCatalogEntry[]> {
  const orgProducts = await getProductsForOrg(orgId);
  if (role !== "viewer" && role !== "manager") return orgProducts;

  const rows = await db
    .select({ productKey: userProducts.productKey })
    .from(userProducts)
    .where(eq(userProducts.userId, userId));
  const grantedKeys = new Set(rows.map((row) => row.productKey));

  return orgProducts.filter((product) => grantedKeys.has(product.key));
}
