import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { maintenancePlans, maintenanceRecords, type MaintenancePlan } from "../db/schema/index.js";
import { kmContexts, MaintenanceError } from "./maintenance.service.js";
import { computePlanStatus, type PlanStatus } from "./maintenanceStatus.js";
import { resolveOdometer, type OdometerSource } from "./odometer.js";
import { getVehicleForOrg } from "./vehicle.service.js";

/**
 * The tagliando: the one service every vehicle gets every 20 000 km. It is the vehicle's plan named "Tagliando" (so the
 * alerts and the list keep working), measured against the vehicle's own current km: the next one is due at the km of the
 * last tagliando plus the interval, and what is left is that minus the km now. Only the km of a tagliando that was done
 * are ever typed here; the km now keep themselves (see odometer.ts).
 */

export const TAGLIANDO_NAME = "Tagliando";
export const TAGLIANDO_INTERVAL_KM = 20_000;

export interface TagliandoRecord {
  id: string;
  doneAt: Date;
  km: number | null;
}

export interface TagliandoView {
  intervalKm: number;
  /** The km (and day) of the last tagliando; null until one is entered. */
  lastKm: number | null;
  lastAt: Date | null;
  /** The vehicle's km now, and where they come from. Null when nothing says them yet. */
  currentKm: number | null;
  source: OdometerSource;
  /** lastKm + interval. */
  dueKm: number | null;
  /** dueKm - currentKm, negative once past it. */
  kmRemaining: number | null;
  status: PlanStatus;
  history: TagliandoRecord[];
}

const isTagliando = sql`lower(${maintenancePlans.name}) = 'tagliando'`;

async function findPlan(vehicleId: string): Promise<MaintenancePlan | undefined> {
  const [plan] = await db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.vehicleId, vehicleId), isTagliando))
    .limit(1);
  return plan;
}

export async function getTagliando(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  now: Date = new Date(),
): Promise<TagliandoView> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new MaintenanceError(404, "Vehicle not found");
  const ctx = (await kmContexts([vehicle])).get(vehicle.id)!;
  const odometer = resolveOdometer(vehicle, ctx, now);
  const plan = await findPlan(vehicleId);

  const lastKm = plan?.lastDoneKm ?? null;
  const status = computePlanStatus(
    { intervalKm: TAGLIANDO_INTERVAL_KM, intervalMonths: null, lastDoneAt: plan?.lastDoneAt ?? null, lastDoneKm: lastKm },
    odometer.km,
    now,
  );
  const history = plan
    ? await db
        .select({ id: maintenanceRecords.id, doneAt: maintenanceRecords.doneAt, km: maintenanceRecords.odometerKm })
        .from(maintenanceRecords)
        .where(eq(maintenanceRecords.planId, plan.id))
        .orderBy(desc(maintenanceRecords.doneAt))
        .limit(20)
    : [];

  return {
    intervalKm: TAGLIANDO_INTERVAL_KM,
    lastKm,
    lastAt: plan?.lastDoneAt ?? null,
    currentKm: odometer.km,
    source: odometer.source,
    dueKm: lastKm !== null ? lastKm + TAGLIANDO_INTERVAL_KM : null,
    kmRemaining: status.kmRemaining,
    status,
    history,
  };
}

export interface TagliandoInput {
  /** The km on the dashboard when the tagliando was done. */
  km: number;
  /** The day it was done; today when left out. */
  doneAt?: Date;
  /** "new": a tagliando that was done. "fix": the last one was entered wrong (a typo in the km or the day). */
  mode?: "new" | "fix";
}

/**
 * Enters a tagliando that was done. The next one is counted from it. A tagliando at more km than the vehicle has now is
 * refused: one of the two is a typo, and a vehicle cannot have been serviced in the future.
 */
export async function registerTagliando(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  input: TagliandoInput,
  now: Date = new Date(),
): Promise<TagliandoView> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new MaintenanceError(404, "Vehicle not found");
  const doneAt = input.doneAt ?? now;
  if (doneAt.getTime() > now.getTime() + 60_000) throw new MaintenanceError(400, "La fecha del tagliando no puede ser futura");

  const ctx = (await kmContexts([vehicle])).get(vehicle.id)!;
  const currentKm = resolveOdometer(vehicle, ctx, now).km;
  if (currentKm !== null && input.km > currentKm) {
    throw new MaintenanceError(
      400,
      `El tagliando no puede ser a más km (${input.km.toLocaleString("es-AR")}) que los km actuales del vehículo (${currentKm.toLocaleString("es-AR")}). Revisa ambos números.`,
    );
  }

  await db.transaction(async (tx) => {
    let [plan] = await tx
      .select()
      .from(maintenancePlans)
      .where(and(eq(maintenancePlans.vehicleId, vehicleId), isTagliando))
      .limit(1);
    if (!plan) {
      [plan] = await tx
        .insert(maintenancePlans)
        .values({ orgId, vehicleId, name: TAGLIANDO_NAME, intervalKm: TAGLIANDO_INTERVAL_KM, intervalMonths: null })
        .returning();
    }

    const [newest] = input.mode === "fix"
      ? await tx.select().from(maintenanceRecords).where(eq(maintenanceRecords.planId, plan!.id)).orderBy(desc(maintenanceRecords.doneAt)).limit(1)
      : [];
    if (newest) {
      await tx.update(maintenanceRecords).set({ doneAt, odometerKm: input.km }).where(eq(maintenanceRecords.id, newest.id));
    } else {
      await tx.insert(maintenanceRecords).values({ planId: plan!.id, doneAt, odometerKm: input.km });
    }

    // The plan counts from the newest tagliando (entering an old one must not push the next due point back).
    const [latest] = await tx
      .select()
      .from(maintenanceRecords)
      .where(eq(maintenanceRecords.planId, plan!.id))
      .orderBy(desc(maintenanceRecords.doneAt))
      .limit(1);
    await tx
      .update(maintenancePlans)
      .set({
        intervalKm: TAGLIANDO_INTERVAL_KM,
        intervalMonths: null,
        lastDoneAt: latest!.doneAt,
        lastDoneKm: latest!.odometerKm,
        kmAdjust: 0,
        updatedAt: now,
      })
      .where(eq(maintenancePlans.id, plan!.id));
  });

  return getTagliando(orgId, allowedArea, vehicleId, now);
}
