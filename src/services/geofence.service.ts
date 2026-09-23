import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { geofences, type Geofence, type NewGeofence } from "../db/schema/index.js";

export async function listGeofencesForOrg(orgId: string): Promise<Geofence[]> {
  return db.select().from(geofences).where(eq(geofences.orgId, orgId));
}

export async function createGeofence(input: NewGeofence): Promise<Geofence> {
  const [row] = await db.insert(geofences).values(input).returning();
  return row!;
}

export async function updateGeofence(
  orgId: string,
  geofenceId: string,
  patch: Partial<Pick<NewGeofence, "name" | "lat" | "lng" | "radiusMeters" | "alertOnEnter" | "alertOnExit">>,
): Promise<Geofence | undefined> {
  const [row] = await db
    .update(geofences)
    .set(patch)
    .where(and(eq(geofences.id, geofenceId), eq(geofences.orgId, orgId)))
    .returning();
  return row;
}

export async function deleteGeofence(orgId: string, geofenceId: string): Promise<boolean> {
  const result = await db.delete(geofences).where(and(eq(geofences.id, geofenceId), eq(geofences.orgId, orgId)));
  return (result.rowCount ?? 0) > 0;
}
