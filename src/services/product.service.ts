import { eq } from "drizzle-orm";
import { PRODUCT_CATALOG, type ProductCatalogEntry } from "../config/products.js";
import { db } from "../db/client.js";
import { organizationProducts } from "../db/schema/index.js";

export async function getProductsForOrg(orgId: string): Promise<ProductCatalogEntry[]> {
  const rows = await db
    .select({ productKey: organizationProducts.productKey })
    .from(organizationProducts)
    .where(eq(organizationProducts.orgId, orgId));

  const enabledKeys = new Set(rows.map((row) => row.productKey));
  return PRODUCT_CATALOG.filter((product) => product.key === "gps" || enabledKeys.has(product.key));
}
