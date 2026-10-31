import type { Vehicle } from "../db/schema/index.js";
import { kmAfterDay, romeDay } from "./dailyKm.service.js";
import type { KmContext } from "./maintenance.service.js";

export type OdometerMode = "auto" | "manual";
/** Where the current km come from: typed by someone, the car's own odometer (OBD), the GPS count on top of a typed km, or nowhere yet. */
export type OdometerSource = "manual" | "obd" | "gps" | "none";

/** After this many days without the dashboard km being typed, a vehicle counted by GPS is due for a check. */
export const RECHECK_AFTER_DAYS = 30;
/** The GPS must have counted at least this much since the last reading before it says anything about its own error. */
const MIN_KM_TO_LEARN = 300;
/** A learned correction outside this range is a typo or a long gap in the track, not the GPS's habit. */
const FACTOR_RANGE = { min: 0.9, max: 1.3 } as const;

export interface OdometerView {
  mode: OdometerMode;
  /** The vehicle's km now, or null when nothing says it yet (auto with no km typed and no odometer to read). */
  km: number | null;
  source: OdometerSource;
  /** The km typed last (dashboard reading) and when. */
  baseKm: number | null;
  baseAt: Date | null;
  /** All the km the GPS has counted for this vehicle, and since which day: shown whatever the mode. */
  gpsKmTotal: number;
  gpsCoverageFrom: string | null;
  /** The GPS km added on top of the typed km (auto mode without an odometer). */
  gpsKmSinceBase: number | null;
  /** The car's own odometer through the tracker, before the correction; null when the device does not read it. */
  trackerKm: number | null;
  offsetKm: number;
  /** The GPS correction learned for this vehicle (1 = none yet) and when it was last learned. */
  kmFactor: number;
  kmFactorAt: Date | null;
  /** Whole days since the dashboard km were last typed; null when they never were. */
  daysSinceBase: number | null;
  /** Counted by GPS and not checked against the dashboard for a while: time to type the km again. */
  needsCheck: boolean;
  /** What the last save did to the correction: learned a new one, or the difference was too big to trust. */
  factorResult?: "updated" | "outOfRange" | null;
}

type OdometerInput = Pick<
  Vehicle,
  "odometerMode" | "odometerBaseKm" | "odometerBaseAt" | "odometerOffsetKm" | "kmFactor" | "kmFactorAt"
>;
type OdometerContext = KmContext & { obdRaw: number | null };

/**
 * The vehicle's current km. Manual: what was typed. Automatic: the car's odometer when the tracker reads it (already
 * lined up with the dashboard by its correction), otherwise the km typed plus the GPS km driven after that day.
 */
export function resolveOdometer(vehicle: OdometerInput, ctx: OdometerContext, now: Date = new Date()): OdometerView {
  const mode: OdometerMode = vehicle.odometerMode === "manual" ? "manual" : "auto";
  const gpsKmTotal = Math.round(ctx.daily.reduce((sum, d) => sum + d.km, 0));
  const shared = {
    baseKm: vehicle.odometerBaseKm,
    baseAt: vehicle.odometerBaseAt,
    gpsKmTotal,
    gpsCoverageFrom: ctx.coverageFrom,
    trackerKm: ctx.obdRaw,
    offsetKm: vehicle.odometerOffsetKm,
    kmFactor: vehicle.kmFactor,
    kmFactorAt: vehicle.kmFactorAt,
    daysSinceBase: vehicle.odometerBaseAt ? Math.floor((now.getTime() - vehicle.odometerBaseAt.getTime()) / 86_400_000) : null,
  };

  if (mode === "manual") {
    return { ...shared, mode, km: vehicle.odometerBaseKm, source: vehicle.odometerBaseKm === null ? "none" : "manual", gpsKmSinceBase: null, needsCheck: false };
  }
  if (ctx.obdKm !== null) return { ...shared, mode, km: ctx.obdKm, source: "obd", gpsKmSinceBase: null, needsCheck: false };
  if (vehicle.odometerBaseKm !== null && vehicle.odometerBaseAt) {
    // Counting starts the day after the reading, like the maintenance plans: the same day's driving is already in it.
    const since = Math.round(kmAfterDay(ctx.daily, romeDay(vehicle.odometerBaseAt)));
    const needsCheck = shared.daysSinceBase !== null && shared.daysSinceBase >= RECHECK_AFTER_DAYS;
    return { ...shared, mode, km: vehicle.odometerBaseKm + since, source: "gps", gpsKmSinceBase: since, needsCheck };
  }
  return { ...shared, mode, km: null, source: "none", gpsKmSinceBase: null, needsCheck: false };
}

/**
 * What the GPS got wrong since the last dashboard reading, as the ratio real / counted. Only a vehicle counted by GPS
 * learns it, and only from a stretch long enough to mean something; the answer is null when there is nothing to learn.
 */
export function learnKmFactor(
  vehicle: Pick<Vehicle, "odometerBaseKm" | "odometerBaseAt">,
  typedKm: number,
  ctx: Pick<KmContext, "rawDaily" | "daily" | "obdKm">,
): { ratio: number; trusted: boolean } | null {
  if (ctx.obdKm !== null || vehicle.odometerBaseKm === null || !vehicle.odometerBaseAt) return null;
  const counted = kmAfterDay(ctx.rawDaily ?? ctx.daily, romeDay(vehicle.odometerBaseAt));
  const driven = typedKm - vehicle.odometerBaseKm;
  if (counted < MIN_KM_TO_LEARN || driven <= 0) return null;
  const ratio = driven / counted;
  return { ratio, trusted: ratio >= FACTOR_RANGE.min && ratio <= FACTOR_RANGE.max };
}

