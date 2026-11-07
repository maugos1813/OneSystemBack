import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import { DEVICE_ALARM_KEYS, DEVICE_ALARMS, isAlarmActive, isTrackingGapActive, TRACKING_GAP_EVENT } from "./deviceAlarms.js";
import { wasParkedWithEngineOff } from "./deviceSilence.js";
import { gpsNoPowerMessage, gpsSilentMessage, isRunningWithoutPower, isSilentWhileMoving } from "./gpsDisconnect.js";
import type { PushMessage } from "./push.service.js";

/**
 * OneSystec's security watch over every device it hands out, whatever the client's own settings say. Urgent findings go out as
 * a push and an email at once (and the "device is down" ones are repeated); the rest is gathered into one email a day.
 */
export type PlatformAlertType =
  | "unplug"
  | "jamming"
  | "towing"
  | "crash"
  | "gps_no_power"
  | "gps_silent"
  | "unknown_device"
  | "immobilizer"
  | "device_silent"
  | "battery_unpowered"
  | "tracking_gap"
  | "device_unassigned"
  | "abroad"
  | "new_user"
  | "login_failed";

export interface TypeInfo {
  severity: "urgent" | "digest";
  /** Announced again while it lasts (a device that is down); the others are said once. */
  reminders: boolean;
  /** A condition that is checked every pass and ends by itself, as opposed to a one-off event that happened. */
  state: boolean;
}

export const TYPE_INFO: Record<PlatformAlertType, TypeInfo> = {
  unplug: { severity: "urgent", reminders: true, state: true },
  jamming: { severity: "urgent", reminders: true, state: true },
  towing: { severity: "urgent", reminders: true, state: true },
  crash: { severity: "urgent", reminders: true, state: true },
  gps_no_power: { severity: "urgent", reminders: true, state: true },
  gps_silent: { severity: "urgent", reminders: true, state: true },
  unknown_device: { severity: "urgent", reminders: false, state: true },
  immobilizer: { severity: "urgent", reminders: false, state: false },
  device_silent: { severity: "digest", reminders: false, state: true },
  battery_unpowered: { severity: "digest", reminders: false, state: true },
  tracking_gap: { severity: "digest", reminders: false, state: true },
  device_unassigned: { severity: "digest", reminders: false, state: true },
  abroad: { severity: "digest", reminders: false, state: true },
  new_user: { severity: "digest", reminders: false, state: false },
  login_failed: { severity: "digest", reminders: false, state: false },
};

export const STATE_TYPES = (Object.keys(TYPE_INFO) as PlatformAlertType[]).filter((type) => TYPE_INFO[type].state);

/** The announced-again cadence of a device that is down, the same as for a client. */
export const PLATFORM_REMINDER_MS = 10 * 60_000;
/** How long a moving vehicle's tracker may stay silent before it is urgent. */
export const SILENCE_MINUTES = 15;
/** A tracker quiet this long (and not parked with the engine off) goes in the daily email; past a week it is just decommissioned. */
export const DEVICE_SILENT_MIN_MS = 3 * 3_600_000;
export const DEVICE_SILENT_MAX_MS = 7 * 24 * 3_600_000;
/** Below this the tracker's own battery (mV) is nearly out: told only when the vehicle's power is gone too. */
export const LOW_INTERNAL_BATTERY_MV = 3600;
/** Failed sign-ins of one account in a day before it is worth a line. */
export const LOGIN_FAILURES_THRESHOLD = 5;

export interface Finding {
  key: string;
  type: PlatformAlertType;
  orgId: string | null;
  deviceId: string | null;
  /** "Cliente · vehículo". */
  subject: string;
  message: string;
}

export interface DeviceContext {
  device: { id: string; imei: string; orgId: string | null; lastSeenAt: Date | null; model: string };
  orgName: string | null;
  vehicleName: string | null;
  position?: { lat: number; lng: number; speed: number; ts?: Date; ioData: unknown };
  alarms: Map<string, { payload: unknown; ts: Date }>;
  now: Date;
}

/** Roughly Italy and its seas: a report from outside is worth a line. Neighbours that overlap the box (Ticino, Slovenia's coast) pass. */
export function isOutsideItaly(lat: number, lng: number): boolean {
  if (lat === 0 && lng === 0) return false;
  return lat < 35.3 || lat > 47.2 || lng < 6.5 || lng > 18.9;
}

const ioNumber = (position: DeviceContext["position"], id: number): number | undefined => {
  const value = (position?.ioData as Record<string, number | string | undefined> | undefined)?.[id];
  return value === undefined || value === null ? undefined : Number(value);
};

const HOUR = 3_600_000;

/** Everything the watch has to say about one device right now. State only: events (an order, a new user) come from elsewhere. */
export function deviceFindings(ctx: DeviceContext): Finding[] {
  const { device, orgName, vehicleName, position, alarms, now } = ctx;
  const subject = `${orgName ?? "Sin cliente"} · ${vehicleName ?? `IMEI ${device.imei}`}`;
  const found: Finding[] = [];
  const add = (type: PlatformAlertType, message: string) =>
    found.push({ key: `${type}:${device.id}`, type, orgId: device.orgId, deviceId: device.id, subject, message });
  const seenAgo = device.lastSeenAt ? now.getTime() - device.lastSeenAt.getTime() : Infinity;

  // A device nobody has claimed that is talking to us: new hardware, or one that should not be here.
  if (!device.orgId) {
    if (seenAgo <= 24 * HOUR) add("unknown_device", `Un dispositivo sin cliente (IMEI ${device.imei}, ${device.model}) se está conectando`);
    return found;
  }

  for (const key of DEVICE_ALARM_KEYS) {
    const alarm = DEVICE_ALARMS[key];
    const event = alarms.get(alarm.eventType);
    if (event && isAlarmActive(event.payload, alarm.avlId, event.ts, now)) add(key, alarm.alert(subject, "es"));
  }

  const reading = position ? { speed: position.speed, ioData: position.ioData } : undefined;
  if (isRunningWithoutPower(reading)) add("gps_no_power", gpsNoPowerMessage(subject, "es"));
  if (isSilentWhileMoving(reading, device.lastSeenAt, SILENCE_MINUTES * 60_000, now)) {
    add("gps_silent", gpsSilentMessage(subject, Math.round(seenAgo / 60_000), "es"));
  }

  if (seenAgo > DEVICE_SILENT_MIN_MS && seenAgo < DEVICE_SILENT_MAX_MS && !wasParkedWithEngineOff(reading)) {
    add("device_silent", `${subject}: lleva ${Math.round(seenAgo / HOUR)} h sin enviar datos`);
  }

  const external = ioNumber(position, AVL_ID.EXTERNAL_VOLTAGE);
  const battery = ioNumber(position, AVL_ID.BATTERY_VOLTAGE);
  if (seenAgo <= 24 * HOUR && external === 0 && battery !== undefined && battery > 0 && battery < LOW_INTERNAL_BATTERY_MV) {
    add("battery_unpowered", `${subject}: sin corriente del vehículo y con la batería interna casi agotada (${(battery / 1000).toFixed(2)} V)`);
  }

  const gap = alarms.get(TRACKING_GAP_EVENT);
  if (gap && isTrackingGapActive(gap.ts, now)) add("tracking_gap", `${subject}: estuvo un rato sin registrar nada y volvió a reportar`);

  if (!vehicleName && seenAgo <= 24 * HOUR) add("device_unassigned", `${subject}: reporta pero no está asignado a ningún vehículo`);

  if (position && seenAgo <= 2 * HOUR && isOutsideItaly(position.lat, position.lng)) {
    add("abroad", `${subject}: está fuera de Italia (${position.lat.toFixed(3)}, ${position.lng.toFixed(3)})`);
  }

  return found;
}

/** The push for a run's urgent findings, or for the reminder of those that are still going on. */
export function securityPushMessage(messages: readonly string[], reminder: boolean): PushMessage {
  const shown = messages.slice(0, 4).join("\n");
  const rest = messages.length - 4;
  return {
    title: `🚨 ${reminder ? "RECORDATORIO · " : ""}Seguridad OneSystec${messages.length > 1 ? ` (${messages.length})` : ""}`,
    body: rest > 0 ? `${shown}\n+${rest} más` : shown,
    data: { url: "/gps", org: "OneSystec" },
    urgent: true,
  };
}

/** The daily summary as a quiet push, for when email is off: how many things and the first few. */
export function securityDigestPushMessage(messages: readonly string[]): PushMessage {
  const shown = messages.slice(0, 4).join("\n");
  const rest = messages.length - 4;
  return {
    title: `Resumen de seguridad OneSystec (${messages.length})`,
    body: rest > 0 ? `${shown}\n+${rest} más` : shown,
    data: { url: "/clientes", org: "OneSystec" },
  };
}

/** Today's `hour`:00 in Rome as an instant: when the daily email becomes due. */
export function romeTodayAt(now: Date, hour: number): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offset = localAsUtc - Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), hour) - offset);
}

export const DIGEST_HOUR = 8;

/** The daily email is due from 08:00 in Rome, once a day. */
export function isDigestDue(now: Date, lastDigestAt: Date | null): boolean {
  const start = romeTodayAt(now, DIGEST_HOUR);
  return now.getTime() >= start.getTime() && (!lastDigestAt || lastDigestAt.getTime() < start.getTime());
}
