import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicles, type NewVehicle, type Vehicle } from "../db/schema/index.js";

export async function listVehiclesForOrg(orgId: string): Promise<Vehicle[]> {
  return db.select().from(vehicles).where(eq(vehicles.orgId, orgId));
}

export async function getVehicleForOrg(orgId: string, vehicleId: string): Promise<Vehicle | undefined> {
  const [row] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)))
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
  patch: Partial<Pick<NewVehicle, "name" | "plate" | "deviceId">>,
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
