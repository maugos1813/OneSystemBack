import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
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
  from?: Date;
  to?: Date;
  flaggedOnly?: boolean;
  limit?: number;
  offset?: number;
}

function scopeConditions(orgId: string, allowedArea?: string | null): SQL[] {
  const conditions = [eq(tollPassages.orgId, orgId)];
  if (allowedArea) conditions.push(eq(vehicles.fleetGroup, allowedArea));
  return conditions;
}

export async function listTollPassages(query: ListTollPassagesQuery): Promise<TollPassageRow[]> {
  const conditions = scopeConditions(query.orgId, query.allowedArea);
  if (query.vehicleId) conditions.push(eq(tollPassages.vehicleId, query.vehicleId));
  if (query.from) conditions.push(gte(tollPassages.ts, query.from));
  if (query.to) conditions.push(lte(tollPassages.ts, query.to));
  if (query.flaggedOnly) conditions.push(eq(tollPassages.flagged, true));

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
