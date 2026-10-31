import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicles, type Vehicle } from "../db/schema/index.js";
import { kmAfterDay, romeDay } from "./dailyKm.service.js";
import { calibrateOdometer, kmContexts, MaintenanceError, type KmContext } from "./maintenance.service.js";
import { getVehicleForOrg, listVehiclesForOrg } from "./vehicle.service.js";

export class ProfileError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

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

export interface VehicleProfile {
  vehicle: Vehicle;
  odometer: OdometerView;
}

export async function getVehicleProfile(orgId: string, allowedArea: string | null | undefined, vehicleId: string): Promise<VehicleProfile> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new ProfileError(404, "Vehicle not found");
  const ctx = (await kmContexts([vehicle])).get(vehicle.id)!;
  return { vehicle, odometer: resolveOdometer(vehicle, ctx) };
}

export interface VehicleOdometerRow {
  vehicleId: string;
  km: number | null;
  source: OdometerSource;
  mode: OdometerMode;
  needsCheck: boolean;
}

/** The current km of every vehicle the caller can see, for the vehicles list. */
export async function listVehicleOdometers(orgId: string, allowedArea: string | null | undefined): Promise<VehicleOdometerRow[]> {
  const visible = await listVehiclesForOrg(orgId, allowedArea);
  const contexts = await kmContexts(visible);
  const now = new Date();
  return visible.map((vehicle) => {
    const view = resolveOdometer(vehicle, contexts.get(vehicle.id)!, now);
    return { vehicleId: vehicle.id, km: view.km, source: view.source, mode: view.mode, needsCheck: view.needsCheck };
  });
}

export interface OdometerInputBody {
  mode: OdometerMode;
  /** What the dashboard reads now. Required for manual the first time; in automatic it is the km the count starts from. */
  km?: number;
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

/**
 * Sets how the vehicle's km are kept. A typed reading is the starting point of the automatic count (the GPS adds what is
 * driven after it) and, being the dashboard's own number, also lines up what depends on it: the correction of a car whose
 * odometer is read and the maintenance plans counted by GPS. Manual keeps exactly what was typed and touches nothing else.
 */
export async function setVehicleOdometer(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  input: OdometerInputBody,
  now: Date = new Date(),
): Promise<OdometerView> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new ProfileError(404, "Vehicle not found");
  const typed = input.km !== undefined;
  if (input.mode === "manual" && !typed && vehicle.odometerBaseKm === null) {
    throw new ProfileError(400, "Indica el kilometraje actual");
  }

  // Typing the dashboard km again, the GPS can see how far off it was: that becomes this vehicle's correction.
  const learned = typed && input.mode === "auto" ? learnKmFactor(vehicle, input.km!, (await kmContexts([vehicle])).get(vehicleId)!) : null;

  if (typed && input.mode === "auto") {
    try {
      await calibrateOdometer(orgId, allowedArea, vehicleId, input.km!);
    } catch (err) {
      // No plan has a service km to line up: the typed reading still stands as the vehicle's own.
      if (!(err instanceof MaintenanceError)) throw err;
    }
  }

  const [row] = await db
    .update(vehicles)
    .set({
      odometerMode: input.mode,
      ...(typed ? { odometerBaseKm: input.km!, odometerBaseAt: now } : {}),
      ...(learned?.trusted ? { kmFactor: Math.round(learned.ratio * 1000) / 1000, kmFactorAt: now } : {}),
    })
    .where(eq(vehicles.id, vehicleId))
    .returning();
  const ctx = (await kmContexts([row!])).get(vehicleId)!;
  const factorResult = learned ? (learned.trusted ? "updated" : "outOfRange") : null;
  return { ...resolveOdometer(row!, ctx, now), factorResult };
}
