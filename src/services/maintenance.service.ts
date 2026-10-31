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
import type { Language } from "./i18n.js";
import { addDays, kmAfterDay, listDailyKm, romeDay, type DailyKm } from "./dailyKm.service.js";
import { computePlanStatus, oemOdometerKm, type PlanStatus } from "./maintenanceStatus.js";
import { getLatestOdometerReading, getLatestReading } from "./position.service.js";
import { getVehicleForOrg, listVehiclesForOrg } from "./vehicle.service.js";

export class MaintenanceError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export type KmSource = "obd" | "gps";

export interface PlanView {
  id: string;
  vehicleId: string;
  name: string;
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneAt: Date | null;
  lastDoneKm: number | null;
  notes: string | null;
  /** Where this plan's kilometres come from: the car's own odometer (OBD) or the GPS route counted since the service. */
  kmSource: KmSource;
  /** Km driven since the last service, when it can be told. */
  kmSince: number | null;
  /** The dashboard reading now, as the last service's km plus what has been driven since. Null when it cannot be told. */
  dashboardKm: number | null;
  /** The service was before the GPS started counting for this vehicle, so the km since it are short by that stretch. */
  partialCoverage: boolean;
  status: PlanStatus;
}

export interface VehicleMaintenanceView {
  vehicleId: string;
  name: string;
  plate: string | null;
  kmSource: KmSource;
  /** The car's own odometer through OBD, before the offset. Null if this vehicle's device doesn't report it. */
  trackerKm: number | null;
  offsetKm: number;
  /** Dashboard-scale odometer (OBD + offset); what plans are measured against when the vehicle has it. */
  odometerKm: number | null;
  /** All the km the GPS has counted for this vehicle, and since which day. */
  gpsKmTotal: number;
  gpsCoverageFrom: string | null;
  plans: PlanView[];
}

/** What a vehicle's km are counted from: the car's odometer when the device reads it, otherwise its daily GPS totals. */
export interface KmContext {
  /** The OBD odometer with the vehicle's offset applied, or null. */
  obdKm: number | null;
  daily: DailyKm[];
  /** The first day the GPS has a total for. */
  coverageFrom: string | null;
}

export interface PlanKm {
  source: KmSource;
  /** The km to measure the plan against (see computePlanStatus). */
  currentKm: number | null;
  kmSince: number | null;
  dashboardKm: number | null;
  partial: boolean;
}

/**
 * Where a plan's km stand. With the car's own odometer it is a plain reading. Otherwise it is the GPS km driven on the
 * days after the service (counting starts the day after) plus the plan's adjustment, on top of the km the service was
 * done at, so the dashboard figure follows without anyone typing it.
 */
export function planKm(plan: Pick<MaintenancePlan, "lastDoneAt" | "lastDoneKm" | "kmAdjust">, ctx: KmContext): PlanKm {
  if (ctx.obdKm !== null) {
    return {
      source: "obd",
      currentKm: ctx.obdKm,
      kmSince: plan.lastDoneKm !== null ? ctx.obdKm - plan.lastDoneKm : null,
      dashboardKm: ctx.obdKm,
      partial: false,
    };
  }
  if (!plan.lastDoneAt) return { source: "gps", currentKm: null, kmSince: null, dashboardKm: null, partial: false };

  const serviceDay = romeDay(plan.lastDoneAt);
  const kmSince = Math.round(kmAfterDay(ctx.daily, serviceDay) + plan.kmAdjust);
  const partial = plan.kmAdjust === 0 && ctx.coverageFrom !== null && addDays(serviceDay, 1) < ctx.coverageFrom;
  return {
    source: "gps",
    currentKm: (plan.lastDoneKm ?? 0) + kmSince,
    kmSince,
    dashboardKm: plan.lastDoneKm !== null ? plan.lastDoneKm + kmSince : null,
    partial,
  };
}

function statusFor(plan: MaintenancePlan, km: PlanKm, now: Date): PlanStatus {
  // Counted by GPS with no km given for the service, the km are "since the service": the baseline is zero.
  const baseline = km.source === "gps" ? { ...plan, lastDoneKm: plan.lastDoneKm ?? 0 } : plan;
  return computePlanStatus(baseline, km.currentKm, now);
}

export function toPlanView(plan: MaintenancePlan, km: PlanKm, now: Date): PlanView {
  return {
    id: plan.id,
    vehicleId: plan.vehicleId,
    name: plan.name,
    intervalKm: plan.intervalKm,
    intervalMonths: plan.intervalMonths,
    lastDoneAt: plan.lastDoneAt,
    lastDoneKm: plan.lastDoneKm,
    notes: plan.notes,
    kmSource: km.source,
    kmSince: km.kmSince,
    dashboardKm: km.dashboardKm,
    partialCoverage: km.partial,
    status: statusFor(plan, km, now),
  };
}

/** The car's own odometer reading in km, or null (no device, or it does not read the car's odometer). */
async function readObdKm(vehicle: Pick<Vehicle, "deviceId">): Promise<number | null> {
  if (!vehicle.deviceId) return null;
  const read = (position: { ioData: unknown } | undefined) =>
    position ? oemOdometerKm(position.ioData as Record<string, number | string>) : null;
  // The newest report often lacks the odometer (a beacon scan, an ignition event): then the last one that had it.
  return read(await getLatestReading(vehicle.deviceId)) ?? read(await getLatestOdometerReading(vehicle.deviceId));
}

export function correctedKm(trackerKm: number | null, offsetKm: number): number | null {
  return trackerKm === null ? null : Math.max(0, trackerKm + offsetKm);
}

export async function kmContexts(vehicles: Vehicle[]): Promise<Map<string, KmContext & { obdRaw: number | null }>> {
  const daily = await listDailyKm(vehicles.map((v) => v.id));
  const entries = await Promise.all(
    vehicles.map(async (vehicle) => {
      const obdRaw = await readObdKm(vehicle);
      const rows = daily.get(vehicle.id) ?? [];
      return [
        vehicle.id,
        { obdRaw, obdKm: correctedKm(obdRaw, vehicle.odometerOffsetKm), daily: rows, coverageFrom: rows[0]?.day ?? null },
      ] as const;
    }),
  );
  return new Map(entries);
}

/** Where every plan stands, for the alert evaluator (which walks every organization's plans). */
export async function planStatusesFor(vehicles: Vehicle[], plans: MaintenancePlan[], now: Date = new Date()): Promise<Map<string, PlanStatus>> {
  const withPlans = vehicles.filter((v) => plans.some((p) => p.vehicleId === v.id));
  const contexts = await kmContexts(withPlans);
  const statuses = new Map<string, PlanStatus>();
  for (const plan of plans) {
    const ctx = contexts.get(plan.vehicleId);
    if (ctx) statuses.set(plan.id, statusFor(plan, planKm(plan, ctx), now));
  }
  return statuses;
}

/** Every vehicle the caller can see, each with its plans and where they stand. */
export async function listMaintenance(
  orgId: string,
  allowedArea: string | null | undefined,
  now: Date = new Date(),
  /** Only this vehicle (the one whose profile is open); it is simply absent when the caller cannot see it. */
  onlyVehicleId?: string,
): Promise<VehicleMaintenanceView[]> {
  const visible = (await listVehiclesForOrg(orgId, allowedArea)).filter((v) => !onlyVehicleId || v.id === onlyVehicleId);
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

  const contexts = await kmContexts(visible);
  const rows = visible.map((vehicle): VehicleMaintenanceView => {
    const ctx = contexts.get(vehicle.id)!;
    return {
      vehicleId: vehicle.id,
      name: vehicle.name,
      plate: vehicle.plate,
      kmSource: ctx.obdKm !== null ? "obd" : "gps",
      trackerKm: ctx.obdRaw,
      offsetKm: vehicle.odometerOffsetKm,
      odometerKm: ctx.obdKm,
      gpsKmTotal: Math.round(ctx.daily.reduce((sum, d) => sum + d.km, 0)),
      gpsCoverageFrom: ctx.coverageFrom,
      plans: plans.filter((p) => p.vehicleId === vehicle.id).map((p) => toPlanView(p, planKm(p, ctx), now)),
    };
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PlanInput {
  name: string;
  intervalKm?: number | null;
  intervalMonths?: number | null;
  lastDoneAt?: Date | null;
  lastDoneKm?: number | null;
  /** What the dashboard reads now, to line the GPS count up with it (when the service was before the GPS started
   * counting, or the count has drifted). Needs the km the service was done at. Ignored on a car whose odometer is read. */
  dashboardKm?: number | null;
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
 * The km the GPS count must add so that "service km + km since" lands on what the dashboard reads now. Zero for a
 * vehicle whose own odometer is read (that one needs no help), and for no dashboard reading.
 */
function kmAdjustFor(
  dashboardKm: number | null | undefined,
  baseline: { lastDoneAt: Date | null; lastDoneKm: number | null },
  ctx: KmContext,
): number {
  if (dashboardKm === null || dashboardKm === undefined || ctx.obdKm !== null) return 0;
  if (baseline.lastDoneKm === null || !baseline.lastDoneAt) {
    throw new MaintenanceError(400, "Para ajustar con el tablero hace falta el km y la fecha del último servicio");
  }
  if (dashboardKm < baseline.lastDoneKm) throw new MaintenanceError(400, "El km del tablero no puede ser menor que el del último servicio");
  const gpsKm = kmAfterDay(ctx.daily, romeDay(baseline.lastDoneAt));
  return Math.round(dashboardKm - baseline.lastDoneKm - gpsKm);
}

async function contextFor(vehicle: Vehicle): Promise<KmContext> {
  return (await kmContexts([vehicle])).get(vehicle.id)!;
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
  const ctx = await contextFor(vehicle);

  const lastDoneAt = input.lastDoneAt ?? now;
  const lastDoneKm = input.lastDoneKm ?? ctx.obdKm;
  const kmAdjust = kmAdjustFor(input.dashboardKm, { lastDoneAt, lastDoneKm }, ctx);

  const [row] = await db
    .insert(maintenancePlans)
    .values({
      orgId,
      vehicleId,
      name: input.name,
      intervalKm: input.intervalKm ?? null,
      intervalMonths: input.intervalMonths ?? null,
      lastDoneAt,
      lastDoneKm,
      kmAdjust,
      notes: input.notes ?? null,
    })
    .returning();
  return toPlanView(row!, planKm(row!, ctx), now);
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

  const vehicle = await requireVehicle(orgId, plan.vehicleId, allowedArea);
  const ctx = await contextFor(vehicle);
  const { dashboardKm, ...fields } = patch;

  // A new baseline starts the count over; a dashboard reading lines the new count up with it.
  const baselineMoved = patch.lastDoneAt !== undefined || patch.lastDoneKm !== undefined;
  const baseline = {
    lastDoneAt: patch.lastDoneAt === undefined ? plan.lastDoneAt : patch.lastDoneAt,
    lastDoneKm: patch.lastDoneKm === undefined ? plan.lastDoneKm : patch.lastDoneKm,
  };
  const kmAdjust =
    dashboardKm !== undefined && dashboardKm !== null ? kmAdjustFor(dashboardKm, baseline, ctx) : baselineMoved ? 0 : plan.kmAdjust;

  const [row] = await db
    .update(maintenancePlans)
    .set({ ...fields, kmAdjust, updatedAt: now })
    .where(eq(maintenancePlans.id, planId))
    .returning();
  return toPlanView(row!, planKm(row!, ctx), now);
}

export async function deletePlan(orgId: string, allowedArea: string | null | undefined, planId: string): Promise<void> {
  await requirePlan(orgId, planId, allowedArea);
  await db.delete(maintenancePlans).where(eq(maintenancePlans.id, planId));
}

export interface RecordInput {
  doneAt?: Date;
  odometerKm?: number | null;
  /** What the dashboard reads now (see PlanInput.dashboardKm); lines the count after this service up with it. */
  dashboardKm?: number | null;
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
  const ctx = await contextFor(vehicle);
  const current = planKm(plan, ctx);
  const doneAt = input.doneAt ?? now;
  if (doneAt.getTime() > now.getTime() + 60_000) throw new MaintenanceError(400, "La fecha del servicio no puede ser futura");

  const odometerKm = input.odometerKm !== undefined ? input.odometerKm : input.doneAt ? null : current.dashboardKm;

  const updated = await db.transaction(async (tx) => {
    await tx.insert(maintenanceRecords).values({ planId, doneAt, odometerKm, notes: input.notes ?? null });
    const isNewest = !plan.lastDoneAt || doneAt.getTime() >= plan.lastDoneAt.getTime();
    if (!isNewest) return plan;
    const lastDoneKm = odometerKm ?? plan.lastDoneKm;
    const [row] = await tx
      .update(maintenancePlans)
      .set({
        lastDoneAt: doneAt,
        lastDoneKm,
        // the count starts over from this service
        kmAdjust: kmAdjustFor(input.dashboardKm, { lastDoneAt: doneAt, lastDoneKm }, ctx),
        updatedAt: now,
      })
      .where(eq(maintenancePlans.id, planId))
      .returning();
    return row!;
  });
  return toPlanView(updated, planKm(updated, ctx), now);
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

export interface Calibration {
  source: KmSource;
  /** The car's OBD odometer before the offset (null when the vehicle is counted by GPS). */
  trackerKm: number | null;
  offsetKm: number;
  odometerKm: number;
}

/**
 * Lines the vehicle up with the number on its dashboard. A car whose own odometer is read gets an offset so that reading
 * matches (and its plans' baselines move with it). Any other vehicle is counted by GPS, so each of its plans takes the
 * adjustment that makes "service km + km since" equal the dashboard now.
 */
export async function calibrateOdometer(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  dashboardKm: number,
): Promise<Calibration> {
  const vehicle = await requireVehicle(orgId, vehicleId, allowedArea);
  const trackerKm = await readObdKm(vehicle);

  if (trackerKm === null) {
    const ctx = await contextFor(vehicle);
    const plans = await db.select().from(maintenancePlans).where(eq(maintenancePlans.vehicleId, vehicleId));
    const adjustable = plans.filter((p) => p.lastDoneKm !== null && p.lastDoneAt !== null && p.lastDoneKm <= dashboardKm);
    if (plans.length > 0 && adjustable.length === 0) {
      throw new MaintenanceError(400, "Ningún plan tiene el km del último servicio (o es mayor que el del tablero)");
    }
    await db.transaction(async (tx) => {
      for (const plan of adjustable) {
        await tx
          .update(maintenancePlans)
          .set({ kmAdjust: kmAdjustFor(dashboardKm, plan, ctx) })
          .where(eq(maintenancePlans.id, plan.id));
      }
    });
    return { source: "gps", trackerKm: null, offsetKm: vehicle.odometerOffsetKm, odometerKm: dashboardKm };
  }

  const offsetKm = dashboardKm - trackerKm;
  const delta = offsetKm - vehicle.odometerOffsetKm;

  await db.transaction(async (tx) => {
    await tx.update(vehicles).set({ odometerOffsetKm: offsetKm }).where(eq(vehicles.id, vehicleId));
    if (delta === 0) return;
    // Every stored km is on the corrected scale, so moving the offset moves the baselines with it — otherwise a plan
    // done "at 8 000 km" would silently mean a different place on the road.
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
  return { source: "obd", trackerKm, offsetKm, odometerKm: dashboardKm };
}

/** All plans of an organization — what the alert evaluator walks each tick. */
export async function listPlansForOrg(orgId: string): Promise<MaintenancePlan[]> {
  return db.select().from(maintenancePlans).where(eq(maintenancePlans.orgId, orgId));
}

/** What a plan's alert says, given where it stands. */
export function maintenanceAlertMessage(vehicleName: string, planName: string, status: PlanStatus, language: Language = "es"): string {
  const it = language === "it";
  if (status.state === "overdue") return `${vehicleName}: ${it ? "manutenzione scaduta" : "mantenimiento vencido"} — ${planName}`;
  const parts: string[] = [];
  if (status.kmRemaining !== null && (status.state === "soon" || status.state === "due") && status.kmRemaining >= 0 && status.dueKm !== null) {
    parts.push(it ? `mancano ${status.kmRemaining.toLocaleString("it-IT")} km` : `faltan ${status.kmRemaining.toLocaleString("es-AR")} km`);
  }
  if (status.daysRemaining !== null && status.daysRemaining <= 30) {
    parts.push(
      status.daysRemaining === 0
        ? it ? "scade oggi" : "vence hoy"
        : it ? `mancano ${status.daysRemaining} giorni` : `faltan ${status.daysRemaining} días`,
    );
  }
  return `${vehicleName}: ${it ? "manutenzione in scadenza" : "mantenimiento próximo"} — ${planName}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
