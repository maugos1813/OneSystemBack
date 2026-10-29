import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicleDailyKm } from "../db/schema/index.js";

/**
 * Kilometres each vehicle drove per day, added up from its GPS positions and kept in vehicle_daily_km. This is what a
 * maintenance plan counts "km since the last service" from: positions are pruned (Radius Velocity routes after a week),
 * a daily total is a few bytes and stays.
 *
 * How a day is added up: between each report and the one before it, the straight distance, as long as
 *  - the gap is short enough to trust (a longer silence says nothing about the road in between),
 *  - the implied speed is possible (a GPS jump is not a drive),
 *  - and the vehicle was moving by its own reported speed (a parked vehicle's GPS wanders a few metres, and those
 *    metres added up over a night would count as kilometres).
 * Straight lines between reports cut corners, so a count over sparse reports (Velocity: every 30 s) reads a little low,
 * a few percent. That is what the optional dashboard correction on a plan is for.
 */

export const KM_TIMEZONE = "Europe/Rome";
const MAX_GAP_S = 300;
const MAX_PLAUSIBLE_KMH = 200;
const MIN_MOVING_KMH = 5;

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: KM_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar day (YYYY-MM-DD) in Rome that an instant falls on. */
export function romeDay(at: Date): string {
  return dayFormat.format(at);
}

/** A calendar day plus or minus whole days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Adds up every vehicle's driving from the start of `fromDay` (Rome) to now and stores one total per vehicle and day,
 * replacing what was there for those days. Always start on a whole day: a day started halfway would be stored short.
 * Returns how many daily totals were written.
 */
export async function recomputeDailyKm(fromDay: string): Promise<number> {
  const { rows } = await db.execute<{ written: number }>(sql`
    with window_start as (
      select (${fromDay}::date)::timestamp at time zone ${KM_TIMEZONE} as ts
    ), s as (
      select p.device_id, p.ts, p.lat, p.lng, p.speed,
             lag(p.ts) over w as p_ts, lag(p.lat) over w as p_lat, lag(p.lng) over w as p_lng, lag(p.speed) over w as p_speed
      from positions p
      where p.device_id in (select device_id from vehicles where device_id is not null)
        and p.ts >= (select ts from window_start) and (p.lat <> 0 or p.lng <> 0)
      window w as (partition by p.device_id order by p.ts)
    ), t as (
      select *, extract(epoch from (ts - p_ts)) as dt,
             6371 * 2 * asin(sqrt(least(1,
               power(sin(radians(lat - p_lat) / 2), 2)
               + cos(radians(p_lat)) * cos(radians(lat)) * power(sin(radians(lng - p_lng) / 2), 2)))) as seg_km
      from s
      where p_ts is not null
    ), daily as (
      select v.id as vehicle_id, ((t.ts at time zone ${KM_TIMEZONE})::date) as day, sum(t.seg_km)::float as km
      from t join vehicles v on v.device_id = t.device_id
      where t.dt > 0 and t.dt <= ${MAX_GAP_S}
        and t.seg_km / (t.dt / 3600.0) < ${MAX_PLAUSIBLE_KMH}
        and greatest(t.speed, t.p_speed) >= ${MIN_MOVING_KMH}
      group by 1, 2
    ), written as (
      insert into vehicle_daily_km (vehicle_id, day, km, updated_at)
      select vehicle_id, day, km, now() from daily
      on conflict (vehicle_id, day) do update set km = excluded.km, updated_at = now()
      returning 1
    )
    select count(*)::int as written from written
  `);
  return rows[0]?.written ?? 0;
}

export interface DailyKm {
  day: string;
  km: number;
}

/** The daily totals of these vehicles, oldest first, optionally only the days after `afterDay`. */
export async function listDailyKm(vehicleIds: string[], afterDay?: string): Promise<Map<string, DailyKm[]>> {
  const byVehicle = new Map<string, DailyKm[]>(vehicleIds.map((id) => [id, []]));
  if (vehicleIds.length === 0) return byVehicle;
  const rows = await db
    .select({ vehicleId: vehicleDailyKm.vehicleId, day: vehicleDailyKm.day, km: vehicleDailyKm.km })
    .from(vehicleDailyKm)
    .where(and(inArray(vehicleDailyKm.vehicleId, vehicleIds), afterDay ? gt(vehicleDailyKm.day, afterDay) : undefined))
    .orderBy(asc(vehicleDailyKm.day));
  for (const row of rows) byVehicle.get(row.vehicleId)?.push({ day: row.day, km: row.km });
  return byVehicle;
}

/** The first day each vehicle has a daily total for, i.e. since when its km are being counted. */
export async function coverageStart(vehicleIds: string[]): Promise<Map<string, string>> {
  if (vehicleIds.length === 0) return new Map();
  const rows = await db
    .select({ vehicleId: vehicleDailyKm.vehicleId, first: sql<string>`min(${vehicleDailyKm.day})::text` })
    .from(vehicleDailyKm)
    .where(inArray(vehicleDailyKm.vehicleId, vehicleIds))
    .groupBy(vehicleDailyKm.vehicleId);
  return new Map(rows.map((r) => [r.vehicleId, r.first]));
}

/** Km driven on the days after `day` (the service day itself is not counted: counting starts the day after). */
export function kmAfterDay(rows: readonly DailyKm[], day: string): number {
  let total = 0;
  for (const row of rows) if (row.day > day) total += row.km;
  return total;
}

export async function dailyKmRowCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(vehicleDailyKm);
  return row?.n ?? 0;
}

/** Everything for one vehicle, handy for tests and for the vehicle's own view. */
export async function vehicleKmTotal(vehicleId: string): Promise<number> {
  const [row] = await db
    .select({ km: sql<number>`coalesce(sum(${vehicleDailyKm.km}), 0)::float` })
    .from(vehicleDailyKm)
    .where(eq(vehicleDailyKm.vehicleId, vehicleId));
  return row?.km ?? 0;
}
