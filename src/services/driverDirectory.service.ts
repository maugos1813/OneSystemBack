import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { driverPeople, driverUsages } from "../db/schema/index.js";

/**
 * Who drove which vehicle, as Gamonal Driver knows it: its drivers (with the phone to call) and each of its services (driver,
 * vehicle, time window). The Driver exposes them read-only under /integraciones/onesystec with a service key; they are copied
 * here so nothing on the map waits for the Driver. The precision is that of a service, not of a minute: a van swapped halfway
 * through a service shows the driver on both vans, and a day without a registered service says nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const BATCH = 500;
/** A service the Driver has no end time for is taken to last this long when asking who had the vehicle at a moment. */
export const UNKNOWN_END_HOURS = 12;

const nullableString = z.string().nullable();
const choferesSchema = z.object({
  data: z.object({
    choferes: z.array(
      z.object({
        id: z.string().min(1),
        nombre: z.string(),
        telefono: nullableString,
        activo: z.boolean(),
        vehiculoHabitual: nullableString,
      }),
    ),
  }),
});
const usosSchema = z.object({
  data: z.object({
    usos: z.array(
      z.object({
        servicioId: z.string().min(1),
        choferId: z.string().min(1),
        placa: z.string().min(1),
        placaFinal: nullableString,
        desde: z.string().datetime(),
        hasta: z.string().datetime().nullable(),
        declarada: z.boolean(),
        estado: z.string(),
      }),
    ),
  }),
});

const orgId = (): string | undefined => env.DRIVER_ORG_ID ?? env.RADIUS_VELOCITY_ORG_ID;

export const isDriverDirectoryConfigured = (): boolean => Boolean(env.DRIVER_INTEGRATION_KEY && orgId());

/** Upper-case without spaces, the way plates are matched between the two systems. */
export const normalizePlate = (plate: string): string => plate.replace(/\s+/g, "").toUpperCase();

/** "+39 333 123-4567" -> "+393331234567", so it can go straight into a tel: link; null when it is not a number. */
export function cleanPhone(raw: string | null): string | null {
  const text = (raw ?? "").trim();
  const digits = text.replace(/\D/g, "");
  return digits.length < 6 ? null : `${text.startsWith("+") ? "+" : ""}${digits}`;
}

async function driverGet(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.DRIVER_API_URL.replace(/\/+$/, "")}/integraciones/onesystec${path}`, {
      headers: { "X-Integration-Key": env.DRIVER_INTEGRATION_KEY! },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gamonal Driver answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/**
 * Copies the Driver's drivers and its services from `daysBack` days ago to `daysAhead` days from now. Services of the window the
 * Driver no longer lists (cancelled, rescheduled) are dropped from the copy. Returns how many it wrote.
 */
export async function syncDriverDirectory(daysBack: number, daysAhead = 1): Promise<{ people: number; usages: number }> {
  const org = orgId();
  if (!env.DRIVER_INTEGRATION_KEY || !org) return { people: 0, usages: 0 };
  const startedAt = new Date();
  const from = new Date(startedAt.getTime() - daysBack * DAY_MS);
  const to = new Date(startedAt.getTime() + daysAhead * DAY_MS);

  const people = choferesSchema.parse(await driverGet("/choferes")).data.choferes;
  const usages = usosSchema.parse(await driverGet(`/usos?desde=${from.toISOString()}&hasta=${to.toISOString()}`)).data.usos;

  for (const batch of chunks(people)) {
    await db
      .insert(driverPeople)
      .values(
        batch.map((p) => ({
          orgId: org,
          externalId: p.id,
          name: p.nombre.trim() || "(sin nombre)",
          phone: cleanPhone(p.telefono),
          active: p.activo,
          habitualPlate: p.vehiculoHabitual ? normalizePlate(p.vehiculoHabitual) : null,
          syncedAt: startedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [driverPeople.orgId, driverPeople.externalId],
        set: {
          name: sql`excluded.name`,
          phone: sql`excluded.phone`,
          active: sql`excluded.active`,
          habitualPlate: sql`excluded.habitual_plate`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }

  for (const batch of chunks(usages)) {
    await db
      .insert(driverUsages)
      .values(
        batch.map((u) => ({
          orgId: org,
          externalId: u.servicioId,
          driverExternalId: u.choferId,
          plate: normalizePlate(u.placa),
          finalPlate: u.placaFinal ? normalizePlate(u.placaFinal) : null,
          startsAt: new Date(u.desde),
          endsAt: u.hasta ? new Date(u.hasta) : null,
          declared: u.declarada,
          status: u.estado,
          syncedAt: startedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [driverUsages.orgId, driverUsages.externalId],
        set: {
          driverExternalId: sql`excluded.driver_external_id`,
          plate: sql`excluded.plate`,
          finalPlate: sql`excluded.final_plate`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          declared: sql`excluded.declared`,
          status: sql`excluded.status`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }

  // What the Driver listed for this window carries this sync's time; anything else in the window is gone from the Driver.
  await db
    .delete(driverUsages)
    .where(
      and(
        eq(driverUsages.orgId, org),
        sql`${driverUsages.startsAt} >= ${from}`,
        lt(driverUsages.startsAt, to),
        lt(driverUsages.syncedAt, startedAt),
      ),
    );

  return { people: people.length, usages: usages.length };
}

export async function driverDirectoryRowCount(): Promise<number> {
  const org = orgId();
  if (!org) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(driverUsages)
    .where(eq(driverUsages.orgId, org));
  return row?.n ?? 0;
}

export interface VehicleUsage {
  driver: { name: string; phone: string | null; active: boolean };
  from: string;
  /** Null when the Driver has no end time for the service. */
  to: string | null;
  /** The hours the driver declared (true), or only the departure and ETA estimate (false). */
  declared: boolean;
  /** The service started on another van and ended on this one, or the other way round: the switch time is unknown. */
  switched: boolean;
  status: string;
}

/** Who had the vehicle with this plate at some point in [from, to], earliest first. */
export async function listVehicleUsages(org: string, plate: string, from: Date, to: Date): Promise<VehicleUsage[]> {
  const p = normalizePlate(plate);
  const rows = await db
    .select({
      plate: driverUsages.plate,
      finalPlate: driverUsages.finalPlate,
      startsAt: driverUsages.startsAt,
      endsAt: driverUsages.endsAt,
      declared: driverUsages.declared,
      status: driverUsages.status,
      name: driverPeople.name,
      phone: driverPeople.phone,
      active: driverPeople.active,
    })
    .from(driverUsages)
    .innerJoin(
      driverPeople,
      and(eq(driverPeople.orgId, driverUsages.orgId), eq(driverPeople.externalId, driverUsages.driverExternalId)),
    )
    .where(
      and(
        eq(driverUsages.orgId, org),
        sql`(${driverUsages.plate} = ${p} OR ${driverUsages.finalPlate} = ${p})`,
        lt(driverUsages.startsAt, to),
        gt(sql`coalesce(${driverUsages.endsAt}, ${driverUsages.startsAt} + make_interval(hours => ${UNKNOWN_END_HOURS}))`, from),
      ),
    )
    .orderBy(asc(driverUsages.startsAt));

  return rows.map((r) => ({
    driver: { name: r.name, phone: r.phone, active: r.active },
    from: r.startsAt.toISOString(),
    to: r.endsAt ? r.endsAt.toISOString() : null,
    declared: r.declared,
    switched: r.finalPlate !== null && r.finalPlate !== r.plate,
    status: r.status,
  }));
}

/**
 * The service to call "the driver" of the vehicle at `at`: one whose window contains that moment (the one that started last, if
 * several), otherwise the one that ended most recently within `graceHours` (a driver who just parked is still who to call).
 */
export function currentUsage(usages: VehicleUsage[], at: Date, graceHours = 3): VehicleUsage | null {
  const t = at.getTime();
  const end = (u: VehicleUsage): number => (u.to ? Date.parse(u.to) : Date.parse(u.from) + UNKNOWN_END_HOURS * 3_600_000);
  const running = usages.filter((u) => Date.parse(u.from) <= t && t < end(u));
  if (running.length > 0) return running.reduce((a, b) => (Date.parse(b.from) > Date.parse(a.from) ? b : a));
  const recent = usages.filter((u) => end(u) <= t && t - end(u) <= graceHours * 3_600_000);
  return recent.length > 0 ? recent.reduce((a, b) => (end(b) > end(a) ? b : a)) : null;
}

export async function syncSafely(daysBack: number): Promise<void> {
  try {
    const written = await syncDriverDirectory(daysBack);
    logger.info({ daysBack, ...written }, "Driver directory synced");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not sync the Driver directory");
  }
}
