import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicles, type NewVehicle, type Vehicle } from "../db/schema/index.js";

/** `allowedArea` is a hard restriction (from the caller's JWT), not an optional UI
 * filter — when set, every read below excludes vehicles outside that área entirely,
 * including a getVehicleForOrg miss (which routes turn into a 404, never leaking that
 * the vehicle exists at all). */
export async function listVehiclesForOrg(orgId: string, allowedArea?: string | null): Promise<Vehicle[]> {
  const conditions = [eq(vehicles.orgId, orgId)];
  if (allowedArea) conditions.push(eq(vehicles.fleetGroup, allowedArea));
  return db
    .select()
    .from(vehicles)
    .where(and(...conditions));
}

export async function getVehicleForOrg(
  orgId: string,
  vehicleId: string,
  allowedArea?: string | null,
): Promise<Vehicle | undefined> {
  const conditions = [eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)];
  if (allowedArea) conditions.push(eq(vehicles.fleetGroup, allowedArea));
  const [row] = await db
    .select()
    .from(vehicles)
    .where(and(...conditions))
    .limit(1);
  return row;
}

export async function createVehicle(input: NewVehicle): Promise<Vehicle> {
  const [row] = await db.insert(vehicles).values(input).returning();
  return row!;
}

export async function updateVehicle(
  orgId: string,
  vehicleId: string,
  patch: Partial<Pick<NewVehicle, "name" | "plate" | "deviceId" | "fleetGroup">>,
): Promise<Vehicle | undefined> {
  const [row] = await db
    .update(vehicles)
    .set(patch)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)))
    .returning();
  return row;
}

export async function deleteVehicle(orgId: string, vehicleId: string): Promise<boolean> {
  const result = await db.delete(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)));
  return (result.rowCount ?? 0) > 0;
}
