import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  maintenancePlans,
  maintenanceRecords,
  vehicles,
  type MaintenancePlan,
  type MaintenanceRecord,
  type Vehicle,
} from "../db/schema/index.js";
import { computePlanStatus, trackerOdometerKm, type PlanStatus } from "./maintenanceStatus.js";
import { getLatestReading } from "./position.service.js";
import { getVehicleForOrg, listVehiclesForOrg } from "./vehicle.service.js";

export class MaintenanceError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface PlanView {
  id: string;
  vehicleId: string;
  name: string;
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneAt: Date | null;
  lastDoneKm: number | null;
  notes: string | null;
  status: PlanStatus;
}

export interface VehicleMaintenanceView {
  vehicleId: string;
  name: string;
  plate: string | null;
  /** What the tracker reports, before the offset. Null if this vehicle's device doesn't report it. */
  trackerKm: number | null;
  offsetKm: number;
  /** Dashboard-scale odometer (tracker + offset); what plans are measured against. */
  odometerKm: number | null;
  plans: PlanView[];
}

export function toPlanView(plan: MaintenancePlan, odometerKm: number | null, now: Date): PlanView {
  return {
    id: plan.id,
    vehicleId: plan.vehicleId,
    name: plan.name,
    intervalKm: plan.intervalKm,
    intervalMonths: plan.intervalMonths,
    lastDoneAt: plan.lastDoneAt,
    lastDoneKm: plan.lastDoneKm,
    notes: plan.notes,
    status: computePlanStatus(plan, odometerKm, now),
  };
}

/** The tracker's current odometer reading in km, or null (no device, or it reports none). */
async function readTrackerKm(vehicle: Pick<Vehicle, "deviceId">): Promise<number | null> {
  if (!vehicle.deviceId) return null;
  const position = await getLatestReading(vehicle.deviceId);
  return position ? trackerOdometerKm(position.ioData as Record<string, number | string>) : null;
}

export function correctedKm(trackerKm: number | null, offsetKm: number): number | null {
  return trackerKm === null ? null : Math.max(0, trackerKm + offsetKm);
}

/** Every vehicle the caller can see, each with its plans and where they stand. */
export async function listMaintenance(
  orgId: string,
  allowedArea: string | null | undefined,
  now: Date = new Date(),
): Promise<VehicleMaintenanceView[]> {
  const visible = await listVehiclesForOrg(orgId, allowedArea);
  if (visible.length === 0) return [];

  const plans = await db
    .select()
    .from(maintenancePlans)
    .where(
      and(
        eq(maintenancePlans.orgId, orgId),
        inArray(
          maintenancePlans.vehicleId,
          visible.map((v) => v.id),
        ),
      ),
    )
    .orderBy(asc(maintenancePlans.name));

  const rows = await Promise.all(
    visible.map(async (vehicle) => {
      const trackerKm = await readTrackerKm(vehicle);
      const odometerKm = correctedKm(trackerKm, vehicle.odometerOffsetKm);
      return {
        vehicleId: vehicle.id,
        name: vehicle.name,
        plate: vehicle.plate,
        trackerKm,
        offsetKm: vehicle.odometerOffsetKm,
        odometerKm,
        plans: plans.filter((p) => p.vehicleId === vehicle.id).map((p) => toPlanView(p, odometerKm, now)),
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PlanInput {
  name: string;
  intervalKm?: number | null;
  intervalMonths?: number | null;
  lastDoneAt?: Date | null;
  lastDoneKm?: number | null;
  notes?: string | null;
}

async function requireVehicle(orgId: string, vehicleId: string, allowedArea: string | null | undefined): Promise<Vehicle> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new MaintenanceError(404, "Vehicle not found");
  return vehicle;
}

async function requirePlan(orgId: string, planId: string, allowedArea: string | null | undefined): Promise<MaintenancePlan> {
  const [plan] = await db
    .select()
    .from(maintenancePlans)
    .where(and(eq(maintenancePlans.id, planId), eq(maintenancePlans.orgId, orgId)))
    .limit(1);
  if (!plan) throw new MaintenanceError(404, "Plan not found");
  // A plan of a vehicle outside the caller's área does not exist for them.
  await requireVehicle(orgId, plan.vehicleId, allowedArea);
  return plan;
}

function assertHasInterval(intervalKm: number | null | undefined, intervalMonths: number | null | undefined): void {
  if (!intervalKm && !intervalMonths) {
    throw new MaintenanceError(400, "Define el intervalo en km, en meses, o en ambos");
  }
}

/**
 * Creates a plan. Without an explicit baseline it starts counting from today at the vehicle's
 * current odometer ("lo acabo de hacer / empiezo a controlarlo desde ahora").
 */
export async function createPlan(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  input: PlanInput,
  now: Date = new Date(),
): Promise<PlanView> {
  assertHasInterval(input.intervalKm, input.intervalMonths);
  const vehicle = await requireVehicle(orgId, vehicleId, allowedArea);
  const odometerKm = correctedKm(await readTrackerKm(vehicle), vehicle.odometerOffsetKm);

  const [row] = await db
    .insert(maintenancePlans)
    .values({
      orgId,
      vehicleId,
      name: input.name,
      intervalKm: input.intervalKm ?? null,
      intervalMonths: input.intervalMonths ?? null,
      lastDoneAt: input.lastDoneAt ?? now,
      lastDoneKm: input.lastDoneKm ?? odometerKm,
      notes: input.notes ?? null,
    })
    .returning();
  return toPlanView(row!, odometerKm, now);
}

export async function updatePlan(
  orgId: string,
  allowedArea: string | null | undefined,
  planId: string,
  patch: Partial<PlanInput>,
  now: Date = new Date(),
): Promise<PlanView> {
  const plan = await requirePlan(orgId, planId, allowedArea);
  const nextKm = patch.intervalKm === undefined ? plan.intervalKm : patch.intervalKm;
  const nextMonths = patch.intervalMonths === undefined ? plan.intervalMonths : patch.intervalMonths;
  assertHasInterval(nextKm, nextMonths);

  const [row] = await db
    .update(maintenancePlans)
    .set({ ...patch, updatedAt: now })
    .where(eq(maintenancePlans.id, planId))
    .returning();
  const vehicle = await requireVehicle(orgId, plan.vehicleId, allowedArea);
  return toPlanView(row!, correctedKm(await readTrackerKm(vehicle), vehicle.odometerOffsetKm), now);
}

export async function deletePlan(orgId: string, allowedArea: string | null | undefined, planId: string): Promise<void> {
  await requirePlan(orgId, planId, allowedArea);
  await db.delete(maintenancePlans).where(eq(maintenancePlans.id, planId));
}

export interface RecordInput {
  doneAt?: Date;
  odometerKm?: number | null;
  notes?: string | null;
}

/**
 * Registers that a service was done. The plan's baseline moves to it unless it is older than the
 * baseline already there (logging a past service must not push the next due point backwards).
 * With no odometer given, the vehicle's current reading is used when the service is dated today.
 */
export async function registerService(
  orgId: string,
  allowedArea: string | null | undefined,
  planId: string,
  input: RecordInput,
  now: Date = new Date(),
): Promise<PlanView> {
  const plan = await requirePlan(orgId, planId, allowedArea);
  const vehicle = await requireVehicle(orgId, plan.vehicleId, allowedArea);
  const currentKm = correctedKm(await readTrackerKm(vehicle), vehicle.odometerOffsetKm);
  const doneAt = input.doneAt ?? now;
  if (doneAt.getTime() > now.getTime() + 60_000) throw new MaintenanceError(400, "La fecha del servicio no puede ser futura");

  const odometerKm = input.odometerKm !== undefined ? input.odometerKm : input.doneAt ? null : currentKm;

  const updated = await db.transaction(async (tx) => {
    await tx.insert(maintenanceRecords).values({ planId, doneAt, odometerKm, notes: input.notes ?? null });
    const isNewest = !plan.lastDoneAt || doneAt.getTime() >= plan.lastDoneAt.getTime();
    if (!isNewest) return plan;
    const [row] = await tx
      .update(maintenancePlans)
      .set({ lastDoneAt: doneAt, lastDoneKm: odometerKm ?? plan.lastDoneKm, updatedAt: now })
      .where(eq(maintenancePlans.id, planId))
      .returning();
    return row!;
  });
  return toPlanView(updated, currentKm, now);
}

export async function listRecords(
  orgId: string,
  allowedArea: string | null | undefined,
  planId: string,
): Promise<MaintenanceRecord[]> {
  await requirePlan(orgId, planId, allowedArea);
  return db
    .select()
    .from(maintenanceRecords)
    .where(eq(maintenanceRecords.planId, planId))
    .orderBy(desc(maintenanceRecords.doneAt))
    .limit(100);
}

/**
 * Sets the vehicle's offset so that the tracker's current reading matches the number on the
 * dashboard. Needs a current tracker reading to compare against.
 */
export async function calibrateOdometer(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  dashboardKm: number,
): Promise<{ trackerKm: number; offsetKm: number; odometerKm: number }> {
  const vehicle = await requireVehicle(orgId, vehicleId, allowedArea);
  const trackerKm = await readTrackerKm(vehicle);
  if (trackerKm === null) {
    throw new MaintenanceError(400, "El dispositivo de este vehículo todavía no informó su kilometraje");
  }
  const offsetKm = dashboardKm - trackerKm;
  const delta = offsetKm - vehicle.odometerOffsetKm;

  await db.transaction(async (tx) => {
    await tx.update(vehicles).set({ odometerOffsetKm: offsetKm }).where(eq(vehicles.id, vehicleId));
    if (delta === 0) return;
    // Every stored km is on the corrected scale, so moving the offset moves the baselines with
    // it — otherwise a plan done "at 8 000 km" would silently mean a different place on the road.
    const planIds = tx.select({ id: maintenancePlans.id }).from(maintenancePlans).where(eq(maintenancePlans.vehicleId, vehicleId));
    await tx
      .update(maintenancePlans)
      .set({ lastDoneKm: sql`${maintenancePlans.lastDoneKm} + ${delta}` })
      .where(eq(maintenancePlans.vehicleId, vehicleId));
    await tx
      .update(maintenanceRecords)
      .set({ odometerKm: sql`${maintenanceRecords.odometerKm} + ${delta}` })
      .where(inArray(maintenanceRecords.planId, planIds));
  });
  return { trackerKm, offsetKm, odometerKm: dashboardKm };
}

/** All plans of an organization — what the alert evaluator walks each tick. */
export async function listPlansForOrg(orgId: string): Promise<MaintenancePlan[]> {
  return db.select().from(maintenancePlans).where(eq(maintenancePlans.orgId, orgId));
}

/** What a plan's alert says, given where it stands. */
export function maintenanceAlertMessage(vehicleName: string, planName: string, status: PlanStatus): string {
  if (status.state === "overdue") return `${vehicleName}: mantenimiento vencido — ${planName}`;
  const parts: string[] = [];
  if (status.kmRemaining !== null && status.state === "soon" && status.kmRemaining >= 0 && status.dueKm !== null) {
    parts.push(`faltan ${status.kmRemaining.toLocaleString("es-AR")} km`);
  }
  if (status.daysRemaining !== null && status.daysRemaining <= 30) {
    parts.push(status.daysRemaining === 0 ? "vence hoy" : `faltan ${status.daysRemaining} días`);
  }
  return `${vehicleName}: mantenimiento próximo — ${planName}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
