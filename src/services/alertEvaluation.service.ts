import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { organizations, users, type Device, type Geofence, type Position, type Vehicle } from "../db/schema/index.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import { localized, toLanguage, type Localized } from "./i18n.js";
import { listGeofencesForOrg } from "./geofence.service.js";
import { isInsidePolygonPath } from "./geofenceGeometry.js";
import { listDevicesForOrg } from "./device.service.js";
import { getLatestAlarmEvents, getLatestPosition, getLatestReading } from "./position.service.js";
import {
  DEVICE_ALARM_KEYS,
  DEVICE_ALARMS,
  isAlarmActive,
  isTrackingGapActive,
  TRACKING_GAP_ALERT,
  TRACKING_GAP_EVENT,
  trackingGapMessage,
} from "./deviceAlarms.js";
import { alertsForRecipient, type AlertRecipient } from "./alertRecipients.js";
import { alertPushMessage, sendPushToUsers } from "./push.service.js";
import { type AlertEmailItem, sendAlertDigest } from "./email.service.js";
import { listDocumentsForOrg } from "./vehicleDocument.service.js";
import { documentAlertMessage, documentName, documentStatus } from "./vehicleDocuments.js";
import { resolveModules } from "./modules.js";
import { getOpenNotification, openNotification, resolveNotification } from "./alertNotification.service.js";
import { type AlertPreferences, type OrgSettings, type WorkingHours, withDefaults } from "./settings.service.js";
import { correctedKm, listPlansForOrg, maintenanceAlertMessage } from "./maintenance.service.js";
import { computePlanStatus, trackerOdometerKm } from "./maintenanceStatus.js";
import { listVehiclesForOrg } from "./vehicle.service.js";

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

/**
 * Handles both shapes. For a polygon, XORing the even-odd result across every ring
 * correctly covers both a hole (an oppositely-wound nested ring) and disjoint separate
 * areas (like Area B's few exclaves) with the same rule.
 */
function isInsideGeofence(position: { lat: number; lng: number }, gf: Geofence): boolean {
  if (gf.type === "polygon") {
    return gf.path ? isInsidePolygonPath(position, gf.path) : false;
  }
  if (gf.lat == null || gf.lng == null || gf.radiusMeters == null) return false;
  return haversineKm(position, { lat: gf.lat, lng: gf.lng }) * 1000 <= gf.radiusMeters;
}

function hasAnyAlertEnabled(alerts: AlertPreferences): boolean {
  return (
    alerts.afterHoursEnabled ||
    alerts.deviceOfflineEnabled ||
    alerts.lowBatteryEnabled ||
    alerts.speedingEnabled ||
    alerts.excessiveIdlingEnabled ||
    alerts.geofenceEnabled ||
    alerts.deviceAlarmsEnabled ||
    alerts.maintenanceEnabled
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
  message: Localized,
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

async function getOwner(orgId: string): Promise<{ id: string; email: string; language: string } | undefined> {
  const [row] = await db
    .select({ id: users.id, email: users.email, language: users.language })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(users.createdAt)
    .limit(1);
  return row;
}

/** The owner (everything) plus every client user of a flota who has the Alertas section (only their flota's). */
async function getAlertRecipients(orgId: string): Promise<AlertRecipient[]> {
  const recipients: AlertRecipient[] = [];
  const owner = await getOwner(orgId);
  if (owner) recipients.push({ userId: owner.id, email: owner.email, language: toLanguage(owner.language), fleetGroup: null });
  const clients = await db
    .select({ id: users.id, email: users.email, role: users.role, allowedArea: users.allowedArea, modules: users.modules, language: users.language })
    .from(users)
    .where(eq(users.orgId, orgId));
  for (const client of clients) {
    if (client.role !== "viewer" && client.role !== "manager") continue;
    if (!client.allowedArea || client.id === owner?.id) continue;
    if (!resolveModules(client.role, client.modules).includes("alertas")) continue;
    recipients.push({ userId: client.id, email: client.email, language: toLanguage(client.language), fleetGroup: client.allowedArea });
  }
  return recipients;
}

async function evaluateOrg(orgId: string, orgName: string, settings: OrgSettings): Promise<void> {
  const vehicles: Vehicle[] = await listVehiclesForOrg(orgId);
  if (vehicles.length === 0) return;

  const devices: Device[] = await listDevicesForOrg(orgId);
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const geofences = settings.alerts.geofenceEnabled ? await listGeofencesForOrg(orgId) : [];

  const plans = settings.alerts.maintenanceEnabled ? await listPlansForOrg(orgId) : [];
  const documents = settings.alerts.maintenanceEnabled ? await listDocumentsForOrg(orgId) : [];

  const collector: AlertEmailItem[] = [];
  const now = new Date();

  // Each alert is tagged with the flota of the vehicle it is about, so it only reaches who may know about it.
  let taggedUpTo = 0;
  let currentFleetGroup: string | null = null;
  const tagNew = () => {
    for (let i = taggedUpTo; i < collector.length; i++) collector[i]!.fleetGroup = currentFleetGroup;
    taggedUpTo = collector.length;
  };

  for (const vehicle of vehicles) {
    tagNew();
    currentFleetGroup = vehicle.fleetGroup;
    const device = vehicle.deviceId ? deviceById.get(vehicle.deviceId) : undefined;
    // With the last known location when there is one; otherwise the raw reading, which still has voltage and ignition.
    const position = device ? ((await getLatestPosition(device.id)) ?? (await getLatestReading(device.id))) : undefined;

    // Before the device checks: a plan counted in months still matters for a vehicle with no tracker.
    for (const plan of plans.filter((p) => p.vehicleId === vehicle.id)) {
      const odometerKm = correctedKm(
        position ? trackerOdometerKm(position.ioData as Record<string, number | string>) : null,
        vehicle.odometerOffsetKm,
      );
      const status = computePlanStatus(plan, odometerKm, now);
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        `maint:${plan.id.slice(0, 8)}`,
        status.state === "soon" || status.state === "overdue",
        localized((lang) => maintenanceAlertMessage(vehicle.name, plan.name, status, lang)),
        collector,
      );
    }

    for (const doc of documents.filter((d) => d.vehicleId === vehicle.id)) {
      const status = documentStatus(doc.expiresOn, doc.remindDays, now);
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        `doc:${doc.id.slice(0, 8)}`,
        status.state !== "ok",
        localized((lang) => documentAlertMessage(vehicle.name, documentName(doc.kind, doc.label, lang), status, lang)),
        collector,
      );
    }

    if (!device) continue;

    if (settings.alerts.deviceOfflineEnabled) {
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        "offline",
        isOffline(device.lastSeenAt, settings.alerts.deviceOfflineHours * 3_600_000),
        localized((lang) => (lang === "it" ? `${vehicle.name} è offline` : `${vehicle.name} está desconectado`)),
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
        localized((lang) => (lang === "it" ? `${vehicle.name} ha la tensione della batteria bassa` : `${vehicle.name} tiene voltaje de batería bajo`)),
        collector,
      );
    }

    if (settings.alerts.deviceAlarmsEnabled) {
      const latest = await getLatestAlarmEvents(device.id);
      for (const key of DEVICE_ALARM_KEYS) {
        const alarm = DEVICE_ALARMS[key];
        const event = latest.get(alarm.eventType);
        await ongoingCondition(
          orgId,
          vehicle.id,
          vehicle.name,
          key,
          !!event && isAlarmActive(event.payload, alarm.avlId, event.ts, now),
          localized((lang) => alarm.alert(vehicle.name, lang)),
          collector,
        );
      }

      const gap = latest.get(TRACKING_GAP_EVENT);
      await ongoingCondition(
        orgId,
        vehicle.id,
        vehicle.name,
        TRACKING_GAP_ALERT,
        !!gap && isTrackingGapActive(gap.ts, now),
        localized((lang) => trackingGapMessage(vehicle.name, gap?.payload, lang)),
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
        localized((lang) =>
          position
            ? lang === "it"
              ? `${vehicle.name} supera il limite di velocità (${Math.round(position.speed)} km/h)`
              : `${vehicle.name} supera el límite de velocidad (${Math.round(position.speed)} km/h)`
            : "",
        ),
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
        localized((lang) => (lang === "it" ? `${vehicle.name} è in uso fuori dall'orario di lavoro` : `${vehicle.name} está en uso fuera del horario laboral`)),
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
        localized((lang) =>
          lang === "it"
            ? `${vehicle.name} è fermo con il motore acceso da più di ${settings.alerts.excessiveIdlingMinutes} min`
            : `${vehicle.name} lleva motor encendido y detenido más de ${settings.alerts.excessiveIdlingMinutes} min`,
        ),
        collector,
      );
    }

    if (settings.alerts.geofenceEnabled && position) {
      for (const gf of geofences) {
        const key = `${vehicle.id}:${gf.id}`;
        const inside = isInsideGeofence(position, gf);
        const seenBefore = insideGeofence.has(key);
        const wasInside = insideGeofence.get(key);
        insideGeofence.set(key, inside);

        if (!seenBefore) continue;
        if (inside && !wasInside && gf.alertOnEnter) {
          collector.push({
            vehicleName: vehicle.name,
            message: localized((lang) => (lang === "it" ? `${vehicle.name} è entrato in "${gf.name}"` : `${vehicle.name} entró a "${gf.name}"`)),
          });
        } else if (!inside && wasInside && gf.alertOnExit) {
          collector.push({
            vehicleName: vehicle.name,
            message: localized((lang) => (lang === "it" ? `${vehicle.name} è uscito da "${gf.name}"` : `${vehicle.name} salió de "${gf.name}"`)),
          });
        }
      }
    }
  }

  tagNew();

  if (collector.length > 0) {
    for (const recipient of await getAlertRecipients(orgId)) {
      const items = alertsForRecipient(collector, recipient);
      if (items.length === 0) continue;
      await sendAlertDigest(recipient.email, orgName, items, recipient.language);
      await sendPushToUsers([recipient.userId], alertPushMessage(orgName, items.map((item) => item.message[recipient.language] ?? item.message.es), recipient.language));
    }
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
