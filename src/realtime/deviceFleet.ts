import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicles } from "../db/schema/index.js";

/**
 * Which flota (área) the vehicle of a device belongs to, remembered for a few seconds. A user limited to one flota only hears the
 * positions of its own, which means asking this for every position that arrives, for every such connection: one lookup shared by
 * all of them (and by the next positions of the same device) instead of one query each time.
 *
 * It is a hard restriction, so the memory is short and is dropped whenever a vehicle is created, changed, deleted or moved between
 * flotas (see invalidateDeviceFleets); the few seconds only cover writers that bypass those.
 */
export const DEVICE_FLEET_TTL_MS = 20_000;
const MAX_ENTRIES = 5_000;

const known = new Map<string, { group: Promise<string | null>; until: number }>();

export function fleetGroupOfDevice(deviceId: string, now: number = Date.now()): Promise<string | null> {
  const hit = known.get(deviceId);
  if (hit && hit.until > now) return hit.group;
  // The promise itself is stored, so connections asking at the same moment share one query.
  const group = db
    .select({ fleetGroup: vehicles.fleetGroup })
    .from(vehicles)
    .where(eq(vehicles.deviceId, deviceId))
    .limit(1)
    .then(([vehicle]) => vehicle?.fleetGroup ?? null);
  if (known.size >= MAX_ENTRIES) known.clear();
  known.set(deviceId, { group, until: now + DEVICE_FLEET_TTL_MS });
  // A failed lookup must not be remembered.
  group.catch(() => known.delete(deviceId));
  return group;
}

/** Forget everything: a vehicle changed, so the next position asks again. */
export function invalidateDeviceFleets(): void {
  known.clear();
}
