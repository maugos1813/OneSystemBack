export type ProductType = "internal" | "external";

export interface ProductCatalogEntry {
  key: string;
  name: string;
  type: ProductType;
  /** For "internal" products: the path inside this same app. */
  path?: string;
  /** For "external" products: the URL of the separate platform (own login). */
  url?: string;
}

/**
 * Fixed list of products shown as cards in the portal. "gps" is always available to
 * every organization; the rest require a row in `organization_products` to appear.
 * A handful of entries that barely change — not worth a DB-backed admin UI yet.
 */
export const PRODUCT_CATALOG: ProductCatalogEntry[] = [
  { key: "gps", name: "GPS", type: "internal", path: "/gps" },
  {
    key: "driver",
    name: "Gamonal Driver",
    type: "external",
    url: "https://falconext-logistica-web.vercel.app/login",
  },
  {
    key: "farmacy",
    name: "Gamonal Farmacy",
    type: "external",
    // TODO: reemplazar por la URL real de Gamonal Farmacy cuando esté disponible.
    url: "https://example.com/gamonal-farmacy",
  },
  {
    key: "nakamacar",
    name: "NakamaCar",
    type: "external",
    url: "https://nakamacar.gamaagostinelli.cl/login",
  },
];
