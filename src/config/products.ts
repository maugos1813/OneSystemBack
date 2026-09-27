export type ProductType = "internal" | "external";

export interface ProductCatalogEntry {
  key: string;
  name: string;
  type: ProductType;
  /** For "internal" products: the path inside this same app. */
  path?: string;
  /** For "external" products: the URL of the separate platform (own login). */
  url?: string;
  /**
   * External products only: this platform's backend has a matching /auth/sso
   * endpoint that exchanges a short-lived ticket (see sso.service.ts) for a
   * real session, so the portal skips its login screen entirely instead of
   * just opening its URL.
   */
  ssoEnabled?: boolean;
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
    ssoEnabled: true,
  },
  {
    key: "farmacy",
    name: "Gamonal Farmacy",
    type: "external",
    // Mismo backend/frontend que Gamonal Driver (bgamonal19/gamonal-dryver---farmacia),
    // solo que por el dominio original de Vercel en vez del alias falconext-logistica-web.
    url: "https://gamonal-dryver-farmacia.vercel.app/login",
    ssoEnabled: true,
  },
  {
    key: "nakamacar",
    name: "NakamaCar",
    type: "external",
    url: "https://nakamacar.gamaagostinelli.cl/login",
  },
];
