import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, vehicles, type NewVehicle, type Vehicle } from "../db/schema/index.js";
import { invalidateDeviceFleets } from "../realtime/deviceFleet.js";

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

/** A vehicle of any client, found by its id alone: for OneSystec only, whose overview lists the vehicles of every client. */
export async function getVehicleAnyOrg(vehicleId: string): Promise<Vehicle | undefined> {
  const [row] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
  return row;
}

/** Whether the device is one of this organization's. */
export async function deviceInOrg(orgId: string, deviceId: string): Promise<boolean> {
  const [row] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  return !!row;
}

export async function createVehicle(input: NewVehicle): Promise<Vehicle> {
  const [row] = await db.insert(vehicles).values(input).returning();
  invalidateDeviceFleets();
  return row!;
}

export async function updateVehicle(
  orgId: string,
  vehicleId: string,
  patch: Partial<
    Pick<NewVehicle, "name" | "plate" | "deviceId" | "fleetGroup" | "brand" | "model" | "year" | "vin" | "fuelType" | "color" | "notes" | "outOfService" | "outOfServiceAt">
  >,
): Promise<Vehicle | undefined> {
  const [row] = await db
    .update(vehicles)
    .set(patch)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)))
    .returning();
  // The live channel remembers which flota each device is in for a few seconds: a change here applies at once.
  invalidateDeviceFleets();
  return row;
}

export async function deleteVehicle(orgId: string, vehicleId: string): Promise<boolean> {
  const result = await db.delete(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)));
  invalidateDeviceFleets();
  return (result.rowCount ?? 0) > 0;
}

/** Whether any of the org's vehicles belongs to this área (used to reject typos when scoping a key). */
export async function fleetGroupExists(orgId: string, fleetGroup: string): Promise<boolean> {
  const [row] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.orgId, orgId), eq(vehicles.fleetGroup, fleetGroup)))
    .limit(1);
  return !!row;
}
