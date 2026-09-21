import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, type Device } from "../db/schema/index.js";

/** Looks up a device by IMEI, auto-creating an "unclaimed" row on first contact. */
export async function findOrCreateDeviceByImei(imei: string): Promise<Device> {
  const [existing] = await db.select().from(devices).where(eq(devices.imei, imei)).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(devices).values({ imei }).returning();
  return created!;
}

export async function touchLastSeen(deviceId: string): Promise<void> {
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}

/** Claims an unclaimed device into an organization. No-op (returns undefined) if the
 * device doesn't exist or already belongs to an organization. */
export async function claimDevice(orgId: string, imei: string): Promise<Device | undefined> {
  const [updated] = await db
    .update(devices)
    .set({ orgId, status: "active" })
    .where(and(eq(devices.imei, imei), isNull(devices.orgId)))
    .returning();
  return updated;
}

export async function listDevicesForOrg(orgId: string): Promise<Device[]> {
  return db.select().from(devices).where(eq(devices.orgId, orgId));
}

export async function getDeviceById(deviceId: string): Promise<Device | undefined> {
  const [row] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  return row;
}
