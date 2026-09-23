import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { organizations, users, type Device, type Position, type Vehicle } from "../db/schema/index.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import { listGeofencesForOrg } from "./geofence.service.js";
import { listDevicesForOrg } from "./device.service.js";
import { getLatestPosition } from "./position.service.js";
import { type AlertEmailItem, sendAlertDigest } from "./email.service.js";
import { getOpenNotification, openNotification, resolveNotification } from "./alertNotification.service.js";
import { type AlertPreferences, type OrgSettings, type WorkingHours, withDefaults } from "./settings.service.js";
import { listVehiclesForOrg } from "./vehicle.service.js";

const GEOFENCE_MAX_KM = 1000; // sanity bound, geofence radii are always far smaller

/** `positions.io_data` is stored as jsonb, which Drizzle infers as `unknown` — this is
 * the same shape the frontend's serializeIoElements() produces (string AVL-id keys). */
type IoData = Record<string, number | string>;
function io(position: Position): IoData {
  return position.ioData as IoData;
}

function isOffline(lastSeenAt: Date | null, thresholdMs: number): boolean {
  if (!lastSeenAt) return true;
  return Date.now() - lastSeenAt.getTime() > thresholdMs;
}

function isLowVoltage(position: Position | undefined, thresholdMv: number): boolean {
  if (!position) return false;
  const voltage = Number(io(position)[AVL_ID.EXTERNAL_VOLTAGE] ?? 0);
  return voltage > 0 && voltage < thresholdMv;
}

function isSpeeding(position: Position | undefined, limitKmh: number): boolean {
  return !!position && position.speed > limitKmh;
}

function isIgnitionOn(position: Position | undefined): boolean {
  if (!position) return false;
  return io(position)[AVL_ID.IGNITION] === 1 || io(position)[AVL_ID.IGNITION] === "1";
}

const WEEKDAY_ORDER: Array<keyof WorkingHours> = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function isAfterHours(date: Date, workingHours: WorkingHours): boolean {
  const day = WEEKDAY_ORDER[date.getDay()]!;
  const config = workingHours[day];
  if (!config.enabled) return true;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [startH, startM] = config.start.split(":").map(Number);
  const [endH, endM] = config.end.split(":").map(Number);
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);
  return minutes < startMinutes || minutes > endMinutes;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function hasAnyAlertEnabled(alerts: AlertPreferences): boolean {
  return (
    alerts.afterHoursEnabled ||
    alerts.deviceOfflineEnabled ||
    alerts.lowBatteryEnabled ||
    alerts.speedingEnabled ||
    alerts.excessiveIdlingEnabled ||
    alerts.geofenceEnabled
  );
}

// In-memory only — lost on a redeploy, which just means idling timers restart from zero
// and the next geofence check treats "current side" as already-known instead of firing a
// crossing. Both are harmless, occasional edge cases; not worth persisting server state
// for a process that's already long-running (the same server that hosts the TCP ingestion).
const idlingStart = new Map<string, number>();
const insideGeofence = new Map<string, boolean>();

async function ongoingCondition(
  orgId: string,
  vehicleId: string,
  vehicleName: string,
  type: string,
  isActive: boolean,
  message: string,
  collector: AlertEmailItem[],
): Promise<void> {
  const open = await getOpenNotification(orgId, vehicleId, type);
  if (isActive) {
    if (!open) {
      await openNotification(orgId, vehicleId, type);
      collector.push({ vehicleName, message });
    }
  } else if (open) {
    await resolveNotification(open.id);
  }
}

async function getOwnerEmail(orgId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(users.createdAt)
    .limit(1);
  return row?.email;
}

async function evaluateOrg(orgId: string, orgName: string, settings: OrgSettings): Promise<void> {
  const vehicles: Vehicle[] = await listVehiclesForOrg(orgId);
  if (vehicles.length === 0) return;

  const devices: Device[] = await listDevicesForOrg(orgId);
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const geofences = settings.alerts.geofenceEnabled ? await listGeofencesForOrg(orgId) : [];

  const collector: AlertEmailItem[] = [];
  const now = new Date();

  for (const vehicle of vehicles) {
    if (!vehicle.deviceId) continue;
    const device = deviceById.get(vehicle.deviceId);
    if (!device) continue;

    const position = await getLatestPosition(device.id);

    if (settings.alerts.deviceOfflineEnabled) {
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "offline",
        isOffline(device.lastSeenAt, settings.alerts.deviceOfflineHours * 3_600_000),
        `${vehicle.name} está desconectado`,
        collector,
      );
    }

    if (settings.alerts.lowBatteryEnabled) {
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "low_voltage",
        isLowVoltage(position, settings.alerts.lowBatteryVoltage * 1000),
        `${vehicle.name} tiene voltaje de batería bajo`,
        collector,
      );
    }

    if (settings.alerts.speedingEnabled) {
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "speeding",
        isSpeeding(position, settings.alerts.speedLimitKmh),
        position ? `${vehicle.name} supera el límite de velocidad (${Math.round(position.speed)} km/h)` : "",
        collector,
      );
    }

    if (settings.alerts.afterHoursEnabled && position) {
      const inUse = position.speed > 0 || isIgnitionOn(position);
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "after_hours",
        inUse && isAfterHours(now, settings.workingHours),
        `${vehicle.name} está en uso fuera del horario laboral`,
        collector,
      );
    }

    if (settings.alerts.excessiveIdlingEnabled && position) {
      const idling = isIgnitionOn(position) && position.speed === 0;
      if (idling) {
        if (!idlingStart.has(vehicle.id)) idlingStart.set(vehicle.id, Date.now());
      } else {
        idlingStart.delete(vehicle.id);
      }
      const start = idlingStart.get(vehicle.id);
      const thresholdMs = settings.alerts.excessiveIdlingMinutes * 60_000;
      const isActive = !!start && Date.now() - start >= thresholdMs;
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "excessive_idling",
        isActive,
        `${vehicle.name} lleva motor encendido y detenido más de ${settings.alerts.excessiveIdlingMinutes} min`,
        collector,
      );
    }

    if (settings.alerts.geofenceEnabled && position) {
      for (const gf of geofences) {
        const key = `${vehicle.id}:${gf.id}`;
        const distanceKm = haversineKm(position, gf);
        if (distanceKm > GEOFENCE_MAX_KM) continue;
        const inside = distanceKm * 1000 <= gf.radiusMeters;
        const seenBefore = insideGeofence.has(key);
        const wasInside = insideGeofence.get(key);
        insideGeofence.set(key, inside);

        if (!seenBefore) continue;
        if (inside && !wasInside && gf.alertOnEnter) {
          collector.push({ vehicleName: vehicle.name, message: `${vehicle.name} entró a "${gf.name}"` });
        } else if (!inside && wasInside && gf.alertOnExit) {
          collector.push({ vehicleName: vehicle.name, message: `${vehicle.name} salió de "${gf.name}"` });
        }
      }
    }
  }

  if (collector.length > 0) {
    const email = await getOwnerEmail(orgId);
    if (email) await sendAlertDigest(email, orgName, collector);
  }
}

export async function evaluateAllOrganizations(): Promise<void> {
  const orgs = await db.select().from(organizations);

  for (const org of orgs) {
    const settings = withDefaults(org.settings);
    if (!hasAnyAlertEnabled(settings.alerts)) continue;
    await evaluateOrg(org.id, org.name, settings).catch((err) => {
      logger.error({ err, orgId: org.id }, "Alert evaluation failed for organization");
    });
  }
}
