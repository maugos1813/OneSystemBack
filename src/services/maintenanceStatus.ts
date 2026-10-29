import { AVL_ID } from "../tcp-server/codec8/avlIds.js";

/** ok = green; soon = orange; due and overdue = red (about to be due, and already past it); unknown = nothing to measure. */
export type MaintenanceState = "ok" | "soon" | "due" | "overdue" | "unknown";

export interface PlanSchedule {
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneAt: Date | null;
  lastDoneKm: number | null;
}

export interface PlanStatus {
  state: MaintenanceState;
  dueKm: number | null;
  /** Negative once past the due point. Null when the odometer or the baseline is unknown. */
  kmRemaining: number | null;
  dueDate: Date | null;
  /** Negative once past the due date. */
  daysRemaining: number | null;
  /** How much of the interval is used (0 = just done, 1 = due, above 1 = overdue); the larger of km and time. */
  usedFraction: number | null;
}

const DAY_MS = 86_400_000;
/**
 * What is left decides the colour. For a km interval it is a share of the interval, so the rule scales: on a 20 000 km
 * service, orange from 8 000 km left (40 %) and red below 4 000 km (20 %, so 3 999 or less). For a time interval:
 * orange in the last 30 days and red in the last 7.
 */
const SOON_KM_SHARE = 0.4;
const DUE_KM_SHARE = 0.2;
const SOON_DAYS = 30;
const DUE_DAYS = 7;

/** Calendar-correct "same day N months later" (Jan 31 + 1 month is the end of February). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInTarget = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTarget));
  return result;
}

/**
 * Where a service stands today. Whichever of the km / time limits comes first decides it;
 * a limit that can't be evaluated (no odometer reading, no baseline) is simply left out, and a
 * plan with nothing evaluable is "unknown" rather than wrongly "ok".
 */
export function computePlanStatus(plan: PlanSchedule, currentKm: number | null, now: Date): PlanStatus {
  let dueKm: number | null = null;
  let kmRemaining: number | null = null;
  let kmUsed: number | null = null;
  let soonByKm = false;
  let dueByKm = false;

  if (plan.intervalKm && plan.lastDoneKm !== null && currentKm !== null) {
    dueKm = plan.lastDoneKm + plan.intervalKm;
    kmRemaining = dueKm - currentKm;
    kmUsed = (currentKm - plan.lastDoneKm) / plan.intervalKm;
    soonByKm = kmRemaining <= plan.intervalKm * SOON_KM_SHARE;
    dueByKm = kmRemaining < plan.intervalKm * DUE_KM_SHARE;
  }

  let dueDate: Date | null = null;
  let daysRemaining: number | null = null;
  let timeUsed: number | null = null;
  let soonByTime = false;
  let dueByTime = false;

  if (plan.intervalMonths && plan.lastDoneAt) {
    dueDate = addMonths(plan.lastDoneAt, plan.intervalMonths);
    daysRemaining = Math.floor((dueDate.getTime() - now.getTime()) / DAY_MS);
    timeUsed = (now.getTime() - plan.lastDoneAt.getTime()) / (dueDate.getTime() - plan.lastDoneAt.getTime());
    soonByTime = daysRemaining <= SOON_DAYS;
    dueByTime = daysRemaining <= DUE_DAYS;
  }

  const evaluable = kmRemaining !== null || daysRemaining !== null;
  const fractions = [kmUsed, timeUsed].filter((f): f is number => f !== null);

  let state: MaintenanceState = "unknown";
  if (evaluable) {
    const overdue = (kmRemaining !== null && kmRemaining < 0) || (daysRemaining !== null && daysRemaining < 0);
    state = overdue ? "overdue" : dueByKm || dueByTime ? "due" : soonByKm || soonByTime ? "soon" : "ok";
  }

  return {
    state,
    dueKm,
    kmRemaining,
    dueDate,
    daysRemaining,
    usedFraction: fractions.length > 0 ? Math.max(0, ...fractions) : null,
  };
}

/**
 * The car's own odometer, read through OBD (ID 389, km), or null when the device does not report it. It is the one
 * odometer that is the dashboard's, so plans use it directly; any other vehicle is counted from its GPS route.
 */
export function oemOdometerKm(ioData: Record<string, number | string> | null | undefined): number | null {
  if (!ioData || ioData["389"] === undefined) return null;
  const oem = Number(ioData["389"]);
  return Number.isFinite(oem) && oem > 0 ? Math.round(oem) : null;
}

/**
 * The vehicle's odometer in km from a position's IO data, before the vehicle's offset.
 * The OEM mileage read through OBD (ID 389, km) is the car's real odometer, so it wins over
 * the tracker's own distance counter (ID 16, metres). Null if the device reports neither.
 */
export function trackerOdometerKm(ioData: Record<string, number | string> | null | undefined): number | null {
  if (!ioData) return null;
  const oem = Number(ioData["389"]);
  if (ioData["389"] !== undefined && Number.isFinite(oem) && oem > 0) return Math.round(oem);
  const meters = Number(ioData[String(AVL_ID.TOTAL_ODOMETER)]);
  if (ioData[String(AVL_ID.TOTAL_ODOMETER)] !== undefined && Number.isFinite(meters) && meters >= 0) {
    return Math.round(meters / 1000);
  }
  return null;
}
