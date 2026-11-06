import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import type { Language } from "./i18n.js";

/**
 * "The GPS is disconnected", told from what the tracker last reported. Two ways it shows, each with its own alert:
 *  - it still reports but says the vehicle's power is gone (external voltage 0) while the vehicle is moving: it runs on its own
 *    battery, so it was unplugged or its wire is cut;
 *  - it stopped reporting altogether while the vehicle was moving: it died, or lost the network on the road.
 * (The tracker's own unplug alarm, AVL 252, is the third signal; it lives with the other device alarms.)
 *
 * A parked vehicle says nothing here on purpose: a tracker wired to the ignition reads 0 V all night and is perfectly fine.
 */

/** A reminder is repeated for at most this long; past it the episode is stale (the vehicle is probably parked for good). */
export const REMINDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The alert evaluator runs every few minutes, and a reminder is stamped a moment after its pass starts, so the next pass at
 * exactly "one interval later" would find it a few seconds short and wait a whole extra pass. This much slack avoids that. */
const REMINDER_SLACK_MS = 60_000;

type Reading = { speed: number; ioData: unknown } | undefined;

/** The vehicle is moving but the tracker reports no external power: it runs on its internal battery. */
export function isRunningWithoutPower(position: Reading): boolean {
  if (!position || !(position.speed > 0)) return false;
  const voltage = (position.ioData as Record<string, number | string | undefined>)[AVL_ID.EXTERNAL_VOLTAGE];
  // A report with no voltage at all says nothing (some models don't send it); only an explicit 0 counts.
  return voltage !== undefined && voltage !== null && Number(voltage) === 0;
}

/** The last thing the tracker said was "moving", and it has not said anything since `thresholdMs` ago. */
export function isSilentWhileMoving(position: Reading, lastSeenAt: Date | null, thresholdMs: number, now: Date = new Date()): boolean {
  if (!position || !(position.speed > 0) || !lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() > thresholdMs;
}

/** Whether an alert episode that is still open is due another reminder. */
export function isReminderDue(episode: { firstTriggeredAt: Date; lastNotifiedAt: Date }, everyMs: number, now: Date = new Date()): boolean {
  if (now.getTime() - episode.firstTriggeredAt.getTime() > REMINDER_MAX_AGE_MS) return false;
  return now.getTime() - episode.lastNotifiedAt.getTime() >= everyMs - REMINDER_SLACK_MS;
}

export function gpsNoPowerMessage(vehicle: string, language: Language = "es"): string {
  return language === "it"
    ? `${vehicle}: il GPS non riceve corrente mentre il veicolo è in movimento (scollegato o cavo tagliato)`
    : `${vehicle}: el GPS no recibe corriente con el vehículo en marcha (desconectado o cable cortado)`;
}

export function gpsSilentMessage(vehicle: string, minutes: number, language: Language = "es"): string {
  return language === "it"
    ? `${vehicle}: il GPS non invia dati da ${minutes} min e il veicolo era in movimento (spento o scollegato)`
    : `${vehicle}: el GPS lleva ${minutes} min sin enviar datos y el vehículo iba en marcha (apagado o desconectado)`;
}
