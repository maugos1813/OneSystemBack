import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicles, type Vehicle } from "../db/schema/index.js";
import { calibrateOdometer, kmContexts, MaintenanceError } from "./maintenance.service.js";
import {
  learnKmFactor,
  resolveOdometer,
  type OdometerMode,
  type OdometerSource,
  type OdometerView,
} from "./odometer.js";
import { getVehicleForOrg, listVehiclesForOrg } from "./vehicle.service.js";

// The km logic is pure and lives in odometer.ts (the maintenance plans use it too); these keep the old import path.
export { learnKmFactor, RECHECK_AFTER_DAYS, resolveOdometer } from "./odometer.js";
export type { OdometerMode, OdometerSource, OdometerView } from "./odometer.js";

export class ProfileError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface VehicleProfile {
  vehicle: Vehicle;
  odometer: OdometerView;
}

export async function getVehicleProfile(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  now: Date = new Date(),
): Promise<VehicleProfile> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new ProfileError(404, "Vehicle not found");
  const ctx = (await kmContexts([vehicle], now)).get(vehicle.id)!;
  return { vehicle, odometer: resolveOdometer(vehicle, ctx, now) };
}

export interface VehicleOdometerRow {
  vehicleId: string;
  km: number | null;
  source: OdometerSource;
  mode: OdometerMode;
  needsCheck: boolean;
}

/** The current km of every vehicle the caller can see, for the vehicles list. */
export async function listVehicleOdometers(
  orgId: string,
  allowedArea: string | null | undefined,
  now: Date = new Date(),
): Promise<VehicleOdometerRow[]> {
  const visible = await listVehiclesForOrg(orgId, allowedArea);
  const contexts = await kmContexts(visible, now);
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
  const learned = typed && input.mode === "auto" ? learnKmFactor(vehicle, input.km!, (await kmContexts([vehicle], now)).get(vehicleId)!) : null;

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
      ...(typed ? { odometerBaseKm: input.km!, odometerBaseAt: now, odometerBaseDayKm: null } : {}),
      ...(learned?.trusted ? { kmFactor: Math.round(learned.ratio * 1000) / 1000, kmFactorAt: now } : {}),
    })
    .where(eq(vehicles.id, vehicleId))
    .returning();
  const ctx = (await kmContexts([row!], now)).get(vehicleId)!;
  const factorResult = learned ? (learned.trusted ? "updated" : "outOfRange") : null;
  return { ...resolveOdometer(row!, ctx, now), factorResult };
}
