import { AVL_ID } from "../tcp-server/codec8/avlIds.js";

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
    alert: (vehicle: string) => `${vehicle}: se desconectó el dispositivo del vehículo (posible manipulación)`,
  },
  jamming: {
    avlId: AVL_ID.JAMMING,
    eventType: "jamming_change",
    alert: (vehicle: string) => `${vehicle}: se detectó interferencia de señal (jamming)`,
  },
  towing: {
    avlId: AVL_ID.TOWING,
    eventType: "towing_change",
    alert: (vehicle: string) => `${vehicle}: se detectó un posible remolque`,
  },
  crash: {
    avlId: AVL_ID.CRASH,
    eventType: "crash_change",
    alert: (vehicle: string) => `${vehicle}: se detectó un posible choque o impacto`,
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
