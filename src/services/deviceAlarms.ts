import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import type { Language } from "./i18n.js";

/**
 * The alarms a Teltonika tracker raises on its own (it decides, from its accelerometer,
 * power rail and radio — not us). Each one arrives as an IO element that is also the
 * Event IO of the record that carries it, so we keep it as a `device_events` row.
 * Values: 0 = clear, anything else = active (crash carries a severity 1–6).
 */
export const DEVICE_ALARMS = {
  unplug: {
    avlId: AVL_ID.UNPLUG,
    eventType: "unplug_change",
    alert: (vehicle: string, language: Language = "es") =>
      language === "it" ? `${vehicle}: il dispositivo è stato scollegato dal veicolo (possibile manomissione)` : `${vehicle}: se desconectó el dispositivo del vehículo (posible manipulación)`,
  },
  jamming: {
    avlId: AVL_ID.JAMMING,
    eventType: "jamming_change",
    alert: (vehicle: string, language: Language = "es") =>
      language === "it" ? `${vehicle}: rilevata interferenza del segnale (jamming)` : `${vehicle}: se detectó interferencia de señal (jamming)`,
  },
  towing: {
    avlId: AVL_ID.TOWING,
    eventType: "towing_change",
    alert: (vehicle: string, language: Language = "es") =>
      language === "it" ? `${vehicle}: rilevato un possibile traino` : `${vehicle}: se detectó un posible remolque`,
  },
  crash: {
    avlId: AVL_ID.CRASH,
    eventType: "crash_change",
    alert: (vehicle: string, language: Language = "es") =>
      language === "it" ? `${vehicle}: rilevato un possibile incidente o urto` : `${vehicle}: se detectó un posible choque o impacto`,
  },
} as const;

export type DeviceAlarmKey = keyof typeof DEVICE_ALARMS;

export const DEVICE_ALARM_KEYS = Object.keys(DEVICE_ALARMS) as DeviceAlarmKey[];

/** An alarm episode older than this is not raised again (an alarm whose "clear" record never
 * arrived must not stay open forever). */
export const ALARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isAlarmActive(payload: unknown, avlId: number, eventTs: Date, now: Date = new Date()): boolean {
  if (now.getTime() - eventTs.getTime() > ALARM_MAX_AGE_MS) return false;
  const value = (payload as Record<string, number | string> | null)?.[String(avlId)];
  return value !== undefined && Number(value) !== 0;
}

/**
 * A stretch in which the tracker recorded nothing at all: it was off or unplugged (a tracker that merely lost coverage keeps
 * recording and sends the backlog later, with its original times). Whatever the vehicle did in that stretch is not in the history —
 * a toll or Area C crossing included — so it is raised as an alert the moment the tracker reports again.
 */
export const TRACKING_GAP_EVENT = "tracking_gap";
export const TRACKING_GAP_ALERT = "tracking_gap";
/** A parked tracker still records at least every few minutes, so an hour of silence is not rest. */
export const TRACKING_GAP_MIN_MS = 60 * 60_000;

export interface TrackingGap {
  from: Date;
  to: Date;
}

/** The stretches without a record: between `previous` (the newest one already stored) and the new `timestamps`, in time order. */
export function findTrackingGaps(previous: Date | null, timestamps: Date[], minGapMs: number = TRACKING_GAP_MIN_MS): TrackingGap[] {
  const gaps: TrackingGap[] = [];
  let last = previous;
  for (const ts of [...timestamps].sort((a, b) => a.getTime() - b.getTime())) {
    if (last && ts.getTime() - last.getTime() >= minGapMs) gaps.push({ from: last, to: ts });
    if (!last || ts.getTime() > last.getTime()) last = ts;
  }
  return gaps;
}

export function isTrackingGapActive(eventTs: Date, now: Date = new Date()): boolean {
  return now.getTime() - eventTs.getTime() <= ALARM_MAX_AGE_MS;
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

export function trackingGapMessage(vehicle: string, payload: unknown, language: Language = "es"): string {
  const { minutes = 0 } = (payload ?? {}) as { minutes?: number };
  return language === "it"
    ? `${vehicle}: il dispositivo è rimasto ${duration(minutes)} senza registrare (spento o scollegato). Il percorso di quel periodo non è stato registrato.`
    : `${vehicle}: el dispositivo estuvo ${duration(minutes)} sin registrar (apagado o desconectado). El recorrido de ese periodo no quedó registrado.`;
}
