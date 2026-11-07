import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicleDeviceAssignments } from "../db/schema/index.js";
import type { DeviceWindow } from "./position.service.js";

/**
 * The devices a vehicle carried, and when: what its history is made of. A vehicle with no record at all (nothing was ever kept for it)
 * falls back to the device it has now, for all of that device's history, which is how it always worked.
 */
export async function getVehicleDeviceWindows(vehicleId: string, currentDeviceId: string | null): Promise<DeviceWindow[]> {
  const rows = await db
    .select({ deviceId: vehicleDeviceAssignments.deviceId, from: vehicleDeviceAssignments.fromTs, to: vehicleDeviceAssignments.toTs })
    .from(vehicleDeviceAssignments)
    .where(eq(vehicleDeviceAssignments.vehicleId, vehicleId))
    .orderBy(asc(vehicleDeviceAssignments.fromTs));
  if (rows.length > 0) return rows;
  return currentDeviceId ? [{ deviceId: currentDeviceId, from: new Date(0), to: null }] : [];
}

/** The devices each of these vehicles carried and when, for all of them at once (what the fleet-wide calculations need). */
export async function getAssignmentWindows(vehicleIds: readonly string[]): Promise<Map<string, DeviceWindow[]>> {
  const out = new Map<string, DeviceWindow[]>();
  if (vehicleIds.length === 0) return out;
  const rows = await db
    .select({
      vehicleId: vehicleDeviceAssignments.vehicleId,
      deviceId: vehicleDeviceAssignments.deviceId,
      from: vehicleDeviceAssignments.fromTs,
      to: vehicleDeviceAssignments.toTs,
    })
    .from(vehicleDeviceAssignments)
    .where(inArray(vehicleDeviceAssignments.vehicleId, [...vehicleIds]))
    .orderBy(asc(vehicleDeviceAssignments.fromTs));
  for (const { vehicleId, ...window } of rows) out.set(vehicleId, [...(out.get(vehicleId) ?? []), window]);
  return out;
}

/** The part of each window that falls inside `from`..`to`; the windows that do not touch it are left out. */
export function clipWindows(windows: readonly DeviceWindow[], from: Date, to: Date): DeviceWindow[] {
  const clipped: DeviceWindow[] = [];
  for (const window of windows) {
    const start = window.from > from ? window.from : from;
    const end = window.to && window.to < to ? window.to : to;
    if (end >= start) clipped.push({ deviceId: window.deviceId, from: start, to: end });
  }
  return clipped;
}
