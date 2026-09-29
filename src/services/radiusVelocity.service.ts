import { and, desc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { deviceEvents, devices, positions, vehicles } from "../db/schema/index.js";
import { publishPosition } from "../realtime/gateway.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";

/**
 * Syncs vehicles tracked by the third-party Radius Velocity ("Kinesis") telematics
 * platform into our own devices/vehicles/positions tables, so they behave identically
 * to a Teltonika-tracked vehicle everywhere in the app (Mapa, Cockpit, Historial,
 * Alertas, Analíticas). Radius Velocity is pull-only (no push/webhooks), so this is
 * driven by a poller — see jobs/radiusVelocityScheduler.ts.
 *
 * Radius Velocity doesn't report satellites, external/battery voltage, or odometer —
 * those are left null/absent rather than faked as 0. Only `ioData["239"]` (ignition)
 * is populated, since that's the only signal it provides that our existing alert logic
 * (isIgnitionOn, isLowVoltage, etc. in alertEvaluation.service.ts) understands.
 */

const OAUTH_URL = "https://www.velocityfleet.com/vapi/v1/accounts/users/oauth2/refresh/";
const POSITIONS_URL = "https://www.velocityfleet.com/api/mobile/kinesis/device-live-positions/";
const ACCESS_TOKEN_TTL_MS = 25 * 60_000;
const KMH_PER_MPH = 1.60934;

interface RvDevice {
  id: number;
  lat: number;
  lon: number;
  vehicle_registration: string;
  ignition: "Y" | "N";
  speed: number;
  speed_measure_text: string;
  direction: number;
  timestamp: string;
}

interface RvDeviceGroup {
  id: number;
  name: string;
  devices: RvDevice[];
}

interface RvLivePositionsResponse {
  device_groups: RvDeviceGroup[];
}

let cachedAccessToken: string | undefined;
let cachedAt = 0;

async function refreshAccessToken(): Promise<string> {
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: env.RADIUS_VELOCITY_REFRESH_TOKEN! }),
  });
  if (!res.ok) throw new Error(`Radius Velocity token refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as { token: string };
  cachedAccessToken = data.token;
  cachedAt = Date.now();
  return data.token;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() - cachedAt < ACCESS_TOKEN_TTL_MS) return cachedAccessToken;
  return refreshAccessToken();
}

async function fetchLivePositions(): Promise<RvDeviceGroup[]> {
  const url = `${POSITIONS_URL}?customer=${env.RADIUS_VELOCITY_CUSTOMER_ID}`;
  let token = await getAccessToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401) {
    // Our TTL guess may be optimistic — force one refresh and retry before giving up.
    token = await refreshAccessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  if (!res.ok) throw new Error(`Radius Velocity positions fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as RvLivePositionsResponse;
  return data.device_groups;
}

function toKmh(speed: number, unit: string): number {
  return unit === "KM/H" ? speed : speed * KMH_PER_MPH;
}

async function findOrCreateDevice(imei: string, orgId: string): Promise<{ id: string }> {
  const [existing] = await db.select().from(devices).where(eq(devices.imei, imei)).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(devices)
    .values({ imei, orgId, status: "active", source: "radius_velocity", model: "Radius Velocity" })
    .returning();
  return created!;
}

async function syncVehicle(orgId: string, deviceId: string, plate: string, fleetGroup: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.orgId, orgId), eq(vehicles.deviceId, deviceId)))
    .limit(1);

  if (!existing) {
    await db.insert(vehicles).values({ orgId, name: plate, plate, fleetGroup, deviceId });
    return;
  }
  if (existing.plate !== plate || existing.fleetGroup !== fleetGroup) {
    await db.update(vehicles).set({ plate, fleetGroup }).where(eq(vehicles.id, existing.id));
  }
}

async function syncDevicePosition(orgId: string, deviceId: string, rv: RvDevice): Promise<void> {
  const ts = new Date(Number(rv.timestamp) * 1000);
  const ignitionOn = rv.ignition === "Y";

  const [lastPosition] = await db
    .select()
    .from(positions)
    .where(eq(positions.deviceId, deviceId))
    .orderBy(desc(positions.ts))
    .limit(1);

  // Radius Velocity is polled, not pushed — the same fix can come back on consecutive
  // ticks if the vehicle hasn't reported anything new. Skip the insert; nothing changed.
  if (lastPosition && lastPosition.ts.getTime() === ts.getTime()) return;

  const ioData = { [String(AVL_ID.IGNITION)]: ignitionOn ? 1 : 0 };

  const [inserted] = await db
    .insert(positions)
    .values({
      deviceId,
      ts,
      lat: rv.lat,
      lng: rv.lon,
      altitude: 0,
      angle: Math.round(rv.direction),
      satellites: null,
      speed: Math.round(toKmh(rv.speed, rv.speed_measure_text)),
      priority: 0,
      ioData,
    })
    .returning();

  const previousIgnition = lastPosition
    ? (lastPosition.ioData as Record<string, number | string>)[String(AVL_ID.IGNITION)]
    : undefined;
  const previousIgnitionOn = previousIgnition === 1 || previousIgnition === "1";
  if (!lastPosition || previousIgnitionOn !== ignitionOn) {
    await db.insert(deviceEvents).values({ deviceId, ts, type: "ignition_change", payload: ioData });
  }

  await db.update(devices).set({ lastSeenAt: ts }).where(eq(devices.id, deviceId));

  if (inserted) publishPosition(orgId, deviceId, inserted);
}

export async function syncRadiusVelocity(): Promise<void> {
  const orgId = env.RADIUS_VELOCITY_ORG_ID;
  if (!env.RADIUS_VELOCITY_REFRESH_TOKEN || !orgId) return;

  const groups = await fetchLivePositions();

  for (const group of groups) {
    for (const rv of group.devices) {
      const imei = `rv-${rv.id}`;
      try {
        const device = await findOrCreateDevice(imei, orgId);
        await syncVehicle(orgId, device.id, rv.vehicle_registration, group.name);
        await syncDevicePosition(orgId, device.id, rv);
      } catch (err) {
        logger.error({ err, imei }, "Radius Velocity: failed to sync device");
      }
    }
  }
}
