import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { tollPassages, tollPlazas, vehicles } from "../db/schema/index.js";

export interface TollPassageRow {
  id: string;
  ts: Date;
  flagged: boolean;
  vehicleId: string;
  vehicleName: string;
  plate: string | null;
  fleetGroup: string | null;
  plazaId: string;
  plazaName: string;
  operator: string | null;
  lat: number;
  lng: number;
}

export interface ListTollPassagesQuery {
  orgId: string;
  /** Hard área restriction from the caller's JWT — null/undefined means unrestricted. */
  allowedArea?: string | null;
  vehicleId?: string;
  /** Narrows to one área on top of `allowedArea` (which stays a hard restriction). */
  fleetGroup?: string;
  from?: Date;
  to?: Date;
  /** Calendar month "YYYY-MM", in Italian local time (where the fleet operates). */
  month?: string;
  flaggedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface TollMonthSummary {
  month: string;
  total: number;
  flagged: number;
  vehicles: number;
}

// Inlined (not a bind parameter) so the SELECT and GROUP BY month expressions are textually
// identical — Postgres wouldn't match them otherwise.
const FLEET_TZ = sql.raw("'Europe/Rome'");

function scopeConditions(orgId: string, allowedArea?: string | null): SQL[] {
  const conditions = [eq(tollPassages.orgId, orgId)];
  if (allowedArea) conditions.push(eq(vehicles.fleetGroup, allowedArea));
  return conditions;
}

function filterConditions(query: Omit<ListTollPassagesQuery, "limit" | "offset">): SQL[] {
  const conditions = scopeConditions(query.orgId, query.allowedArea);
  if (query.vehicleId) conditions.push(eq(tollPassages.vehicleId, query.vehicleId));
  if (query.fleetGroup) conditions.push(eq(vehicles.fleetGroup, query.fleetGroup));
  if (query.from) conditions.push(gte(tollPassages.ts, query.from));
  if (query.to) conditions.push(lte(tollPassages.ts, query.to));
  if (query.month) {
    // `month` is validated as YYYY-MM by the route; bound as a parameter either way.
    const monthStart = sql`(${`${query.month}-01`}::timestamp)`;
    conditions.push(
      sql`${tollPassages.ts} >= (${monthStart} AT TIME ZONE ${FLEET_TZ})`,
      sql`${tollPassages.ts} < ((${monthStart} + interval '1 month') AT TIME ZONE ${FLEET_TZ})`,
    );
  }
  if (query.flaggedOnly) conditions.push(eq(tollPassages.flagged, true));
  return conditions;
}

/** Per-month totals only (a handful of rows per year) — lets the UI list the months
 * without loading any passage until one is opened. */
export async function listTollMonths(
  query: Omit<ListTollPassagesQuery, "limit" | "offset" | "month" | "from" | "to">,
): Promise<TollMonthSummary[]> {
  const month = sql<string>`to_char(${tollPassages.ts} AT TIME ZONE ${FLEET_TZ}, 'YYYY-MM')`;
  return db
    .select({
      month,
      total: sql<number>`count(*)::int`,
      flagged: sql<number>`(count(*) filter (where ${tollPassages.flagged}))::int`,
      vehicles: sql<number>`count(distinct ${tollPassages.vehicleId})::int`,
    })
    .from(tollPassages)
    .innerJoin(vehicles, eq(tollPassages.vehicleId, vehicles.id))
    .where(and(...filterConditions(query)))
    .groupBy(month)
    .orderBy(desc(month));
}

export async function listTollPassages(query: ListTollPassagesQuery): Promise<TollPassageRow[]> {
  const conditions = filterConditions(query);

  return db
    .select({
      id: tollPassages.id,
      ts: tollPassages.ts,
      flagged: tollPassages.flagged,
      vehicleId: vehicles.id,
      vehicleName: vehicles.name,
      plate: vehicles.plate,
      fleetGroup: vehicles.fleetGroup,
      plazaId: tollPlazas.id,
      plazaName: tollPlazas.name,
      operator: tollPlazas.operator,
      lat: tollPlazas.lat,
      lng: tollPlazas.lng,
    })
    .from(tollPassages)
    .innerJoin(vehicles, eq(tollPassages.vehicleId, vehicles.id))
    .innerJoin(tollPlazas, eq(tollPassages.plazaId, tollPlazas.id))
    .where(and(...conditions))
    .orderBy(desc(tollPassages.ts))
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0);
}

export async function setTollPassageFlagged(
  orgId: string,
  passageId: string,
  flagged: boolean,
  allowedArea?: string | null,
): Promise<boolean> {
  const [visible] = await db
    .select({ id: tollPassages.id })
    .from(tollPassages)
    .innerJoin(vehicles, eq(tollPassages.vehicleId, vehicles.id))
    .where(and(eq(tollPassages.id, passageId), ...scopeConditions(orgId, allowedArea)))
    .limit(1);
  if (!visible) return false;

  await db.update(tollPassages).set({ flagged }).where(eq(tollPassages.id, passageId));
  return true;
}
