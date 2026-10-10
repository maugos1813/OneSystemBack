import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listVehiclesForOrg } from "./vehicle.service.js";

/**
 * Driving-style scores — the single implementation behind both the public /v1 API and the
 * app's Conducción page. Everything is aggregated inside Postgres, so a request moves a few
 * numbers over the wire instead of every GPS sample.
 *
 * The rules are physical, not "did the speed change by X between two reports", so the result
 * doesn't depend on how often a device happens to report:
 *  - harsh braking / acceleration: deceleration / acceleration between consecutive reports
 *  - harsh cornering: lateral acceleration (speed x rate of heading change)
 *  - speeding: a stretch that stays over the limit for a few seconds (GPS speed has
 *    single-report blips that must not count)
 * and scores are per 100 km driven, so a vehicle that drives 3,000 km isn't punished
 * relative to one that drives 300.
 */

// Thresholds (m/s²; 1 g ≈ 9.8). Typical "harsh event" levels for road vehicles, chosen after
// calibrating against a real week of a delivery van (see git history of this file).
const HARSH_BRAKING_MS2 = 3.5;
const HARSH_ACCELERATION_MS2 = 3.0;
const HARSH_CORNERING_MS2 = 4.0;
/** Ignore tiny speed changes at very short report intervals (GPS speed resolution noise). */
const MIN_SPEED_CHANGE_KMH = 10;
/** Heading from GPS is unreliable when crawling. */
const MIN_CORNERING_SPEED_KMH = 25;
/** The physics only holds between reports this close; further apart they're averaged away. */
const MAX_DENSE_GAP_S = 10;
const MIN_SPEEDING_STRETCH_S = 10;
const MOVING_SPEED_KMH = 3;
const MAX_TRACKED_GAP_S = 120;
const MAX_PLAUSIBLE_KMH = 250;
const TRIP_STOP_MINUTES = 3;

/** Points lost for each incident per 100 km driven. */
const POINTS_PER_INCIDENT_PER_100KM = 5;
/** Below this distance a rate per 100 km says nothing. */
const MIN_DISTANCE_KM = 20;
/** Share of the distance that must be covered by dense reports for the harsh-event rules to mean anything. */
const MIN_DENSE_SHARE = 0.5;

export const DEFAULT_SPEED_LIMIT_KMH = 120;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 500;

export const DRIVING_RULES = {
  harshBrakingMs2: HARSH_BRAKING_MS2,
  harshAccelerationMs2: HARSH_ACCELERATION_MS2,
  harshCorneringMs2: HARSH_CORNERING_MS2,
  speedingMinSeconds: MIN_SPEEDING_STRETCH_S,
  pointsPerIncidentPer100Km: POINTS_PER_INCIDENT_PER_100KM,
  minDistanceKm: MIN_DISTANCE_KM,
} as const;

export interface IncidentCounts {
  harshBraking: number;
  harshAcceleration: number;
  harshCornering: number;
  speeding: number;
}

export type DrivingQuality = "full" | "speeding_only" | "insufficient_data" | "no_data";

export interface DrivingScores {
  overall: number;
  /** null when the device reports too sparsely to detect harsh events (quality "speeding_only"). */
  harshBraking: number | null;
  harshAcceleration: number | null;
  harshCornering: number | null;
  speeding: number;
  grade: "A+" | "A" | "B" | "C" | "D";
}

/** 1-100, where 100 is spotless — never 0, matching the app's rings. */
export function scoreFromRate(incidentsPer100Km: number): number {
  return Math.max(1, Math.min(100, Math.round(100 - incidentsPer100Km * POINTS_PER_INCIDENT_PER_100KM)));
}

export function scoreGrade(score: number): DrivingScores["grade"] {
  if (score >= 90) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

export interface RawStats {
  samples: number;
  distanceKm: number;
  denseKm: number;
  movingSeconds: number;
  trips: number;
  harshBraking: number;
  harshAcceleration: number;
  harshCornering: number;
  speeding: number;
}

export interface VehicleDrivingStyle {
  vehicleId: string;
  name: string;
  plate: string | null;
  fleetGroup: string | null;
  /** GPS reports analysed in the period. 0 means there is no data, not perfect driving. */
  samples: number;
  distanceKm: number;
  /** Hours spent moving. */
  drivingHours: number;
  trips: number;
  quality: DrivingQuality;
  scores: DrivingScores | null;
  /** Incident counts; null for the harsh categories when they can't be detected. */
  incidents: {
    harshBraking: number | null;
    harshAcceleration: number | null;
    harshCornering: number | null;
    speeding: number;
  };
  /** Incidents per 100 km driven (what the scores are based on); null without enough distance. */
  incidentsPer100Km: {
    harshBraking: number | null;
    harshAcceleration: number | null;
    harshCornering: number | null;
    speeding: number;
  } | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: raw aggregate numbers -> what the API returns for one vehicle. */
export function summarize(stats: RawStats | undefined): Omit<VehicleDrivingStyle, "vehicleId" | "name" | "plate" | "fleetGroup"> {
  const noIncidents = { harshBraking: 0, harshAcceleration: 0, harshCornering: 0, speeding: 0 };
  if (!stats || stats.samples === 0) {
    return { samples: 0, distanceKm: 0, drivingHours: 0, trips: 0, quality: "no_data", scores: null, incidents: noIncidents, incidentsPer100Km: null };
  }

  const base = {
    samples: stats.samples,
    distanceKm: round1(stats.distanceKm),
    drivingHours: round1(stats.movingSeconds / 3600),
    trips: stats.trips,
  };

  // Whether the device reported densely enough to see harsh events at all. With no distance to
  // judge by (parked), there is nothing to contradict the counts, so they stand.
  const detectable = stats.distanceKm === 0 || stats.denseKm / stats.distanceKm >= MIN_DENSE_SHARE;

  if (stats.distanceKm < MIN_DISTANCE_KM) {
    // Too short to score — but the raw counts are still returned, so a caller can add up many
    // short stretches and score the total with the same formula.
    return {
      ...base,
      quality: "insufficient_data",
      scores: null,
      incidents: detectable
        ? {
            harshBraking: stats.harshBraking,
            harshAcceleration: stats.harshAcceleration,
            harshCornering: stats.harshCornering,
            speeding: stats.speeding,
          }
        : { harshBraking: null, harshAcceleration: null, harshCornering: null, speeding: stats.speeding },
      incidentsPer100Km: null,
    };
  }

  const per100 = (n: number) => round1((n / stats.distanceKm) * 100);

  const speeding = scoreFromRate(per100(stats.speeding));
  const harsh = detectable
    ? {
        harshBraking: scoreFromRate(per100(stats.harshBraking)),
        harshAcceleration: scoreFromRate(per100(stats.harshAcceleration)),
        harshCornering: scoreFromRate(per100(stats.harshCornering)),
      }
    : { harshBraking: null, harshAcceleration: null, harshCornering: null };

  const available = [speeding, harsh.harshBraking, harsh.harshAcceleration, harsh.harshCornering].filter(
    (n): n is number => n !== null,
  );
  const overall = Math.round(available.reduce((sum, n) => sum + n, 0) / available.length);

  return {
    ...base,
    quality: detectable ? "full" : "speeding_only",
    scores: { overall, ...harsh, speeding, grade: scoreGrade(overall) },
    incidents: detectable
      ? { harshBraking: stats.harshBraking, harshAcceleration: stats.harshAcceleration, harshCornering: stats.harshCornering, speeding: stats.speeding }
      : { harshBraking: null, harshAcceleration: null, harshCornering: null, speeding: stats.speeding },
    incidentsPer100Km: detectable
      ? {
          harshBraking: per100(stats.harshBraking),
          harshAcceleration: per100(stats.harshAcceleration),
          harshCornering: per100(stats.harshCornering),
          speeding: per100(stats.speeding),
        }
      : { harshBraking: null, harshAcceleration: null, harshCornering: null, speeding: per100(stats.speeding) },
  };
}

/** Shared SQL: consecutive-report pairs with the derived gap, heading change and distance. */
function pairsCte(deviceIdList: ReturnType<typeof sql.join>, from: Date, to: Date) {
  return sql`
    s as (
      select device_id, ts, lat, lng, speed, angle,
             lag(ts) over w as p_ts, lag(speed) over w as p_speed, lag(angle) over w as p_angle,
             lag(lat) over w as p_lat, lag(lng) over w as p_lng
      from positions
      where device_id in (${deviceIdList}) and ts >= ${from} and ts <= ${to}
      window w as (partition by device_id order by ts)
    ), t as (
      select *,
             extract(epoch from (ts - p_ts)) as dt,
             least(abs(angle - p_angle), 360 - abs(angle - p_angle)) as angle_delta,
             6371 * 2 * asin(sqrt(least(1,
               power(sin(radians(lat - p_lat) / 2), 2)
               + cos(radians(p_lat)) * cos(radians(lat)) * power(sin(radians(lng - p_lng) / 2), 2)))) as seg_km
      from s
    )`;
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const isBraking = sql`dt > 0 and dt <= ${MAX_DENSE_GAP_S} and p_speed - speed >= ${MIN_SPEED_CHANGE_KMH}
  and (p_speed - speed) / 3.6 / dt >= ${HARSH_BRAKING_MS2}`;
const isAcceleration = sql`dt > 0 and dt <= ${MAX_DENSE_GAP_S} and speed - p_speed >= ${MIN_SPEED_CHANGE_KMH}
  and (speed - p_speed) / 3.6 / dt >= ${HARSH_ACCELERATION_MS2}`;
const isCornering = sql`dt > 0 and dt <= ${MAX_DENSE_GAP_S} and speed >= ${MIN_CORNERING_SPEED_KMH}
  and p_speed >= ${MIN_CORNERING_SPEED_KMH}
  and ((speed + p_speed) / 2.0 / 3.6) * radians(angle_delta) / dt >= ${HARSH_CORNERING_MS2}`;

export async function queryStats(deviceIds: string[], from: Date, to: Date, speedLimitKmh: number): Promise<Map<string, RawStats>> {
  if (deviceIds.length === 0) return new Map();
  const ids = idList(deviceIds);
  const plausible = sql`seg_km / (dt / 3600.0) < ${MAX_PLAUSIBLE_KMH}`;

  const { rows } = await db.execute<{
    device_id: string;
    samples: number;
    km: number;
    dense_km: number;
    moving_s: number;
    braking: number;
    acceleration: number;
    cornering: number;
    speeding: number;
    trips: number;
  }>(sql`
    with ${pairsCte(ids, from, to)}, r as (
      select *, sum(case when speed > ${speedLimitKmh} and not coalesce(p_speed > ${speedLimitKmh}, false) then 1 else 0 end)
                  over (partition by device_id order by ts) as run_id
      from t
    ), runs as (
      -- a stretch over the limit counts once, and only if it lasts: single-report GPS blips don't
      select device_id, count(*)::int as speeding
      from (
        select device_id, run_id from r
        where speed > ${speedLimitKmh}
        group by device_id, run_id
        having extract(epoch from (max(ts) - min(ts))) >= ${MIN_SPEEDING_STRETCH_S}
      ) q
      group by device_id
    ), trips as (
      select device_id, (count(*) filter (where p is null or ts - p >= interval '${sql.raw(String(TRIP_STOP_MINUTES))} minutes'))::int as trips
      from (
        select device_id, ts, lag(ts) over (partition by device_id order by ts) as p
        from positions
        where device_id in (${ids}) and ts >= ${from} and ts <= ${to} and speed > 0
      ) m
      group by device_id
    ), agg as (
      select device_id,
             count(*)::int as samples,
             coalesce(sum(case when dt > 0 and dt <= ${MAX_TRACKED_GAP_S} and ${plausible} then seg_km end), 0)::float as km,
             coalesce(sum(case when dt > 0 and dt <= ${MAX_DENSE_GAP_S} and ${plausible} then seg_km end), 0)::float as dense_km,
             coalesce(sum(case when speed > ${MOVING_SPEED_KMH} and dt > 0 and dt <= ${MAX_TRACKED_GAP_S} then dt end), 0)::float as moving_s,
             (count(*) filter (where ${isBraking}))::int as braking,
             (count(*) filter (where ${isAcceleration}))::int as acceleration,
             (count(*) filter (where ${isCornering}))::int as cornering
      from t
      group by device_id
    )
    select a.*, coalesce(runs.speeding, 0) as speeding, coalesce(trips.trips, 0) as trips
    from agg a
    left join runs on runs.device_id = a.device_id
    left join trips on trips.device_id = a.device_id
  `);

  return new Map(
    rows.map((r) => [
      r.device_id,
      {
        samples: r.samples,
        distanceKm: r.km,
        denseKm: r.dense_km,
        movingSeconds: r.moving_s,
        trips: r.trips,
        harshBraking: r.braking,
        harshAcceleration: r.acceleration,
        harshCornering: r.cornering,
        speeding: r.speeding,
      },
    ]),
  );
}

const cache = new Map<string, { expiresAt: number; value: VehicleDrivingStyle[] }>();

export interface DrivingStyleQuery {
  orgId: string;
  allowedArea?: string | null;
  /** Restrict to one vehicle; omitted = the whole fleet. */
  vehicleId?: string;
  /** Window ending now; ignored when `from` is given. */
  days: number;
  /** Start of the window; overrides `days`. */
  from?: Date;
  /** End of the window (only with `from`); omitted = now. The caller has already validated it. */
  to?: Date;
  speedLimitKmh: number;
}

export interface DrivingStyleResult {
  /** null when an exact from/to window was requested. */
  days: number | null;
  speedLimitKmh: number;
  from: Date;
  to: Date;
  vehicles: VehicleDrivingStyle[];
}

/** A stretch that ended long ago can't change (barring late-arriving buffered reports). */
const CLOSED_WINDOW_AFTER_MS = 10 * 60_000;
const CLOSED_WINDOW_CACHE_TTL_MS = 60 * 60_000;

export async function getDrivingStyle(query: DrivingStyleQuery): Promise<DrivingStyleResult> {
  const exactWindow = query.from !== undefined && query.to !== undefined;
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - query.days * 24 * 60 * 60 * 1000);
  const result = (vehicles: VehicleDrivingStyle[]): DrivingStyleResult => ({
    days: exactWindow ? null : query.days,
    speedLimitKmh: query.speedLimitKmh,
    from,
    to,
    vehicles,
  });

  // Exact windows are keyed by both ends; `days`/since-midnight requests keep their original key.
  const windowKey = exactWindow ? `${from.toISOString()}..${to.toISOString()}` : (query.from?.toISOString() ?? query.days);
  const cacheKey = `${query.orgId}|${query.allowedArea ?? ""}|${query.vehicleId ?? "*"}|${windowKey}|${query.speedLimitKmh}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return result(cached.value);

  const fleet = (await listVehiclesForOrg(query.orgId, query.allowedArea)).filter(
    (v) => !query.vehicleId || v.id === query.vehicleId,
  );
  const deviceIds = fleet.flatMap((v) => (v.deviceId ? [v.deviceId] : []));
  const statsByDevice = await queryStats(deviceIds, from, to, query.speedLimitKmh);

  const vehicles: VehicleDrivingStyle[] = fleet.map((v) => ({
    vehicleId: v.id,
    name: v.name,
    plate: v.plate,
    fleetGroup: v.fleetGroup,
    ...summarize(v.deviceId ? statsByDevice.get(v.deviceId) : undefined),
  }));

  const closed = exactWindow && Date.now() - to.getTime() > CLOSED_WINDOW_AFTER_MS;
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!); // oldest first
  cache.set(cacheKey, { expiresAt: Date.now() + (closed ? CLOSED_WINDOW_CACHE_TTL_MS : CACHE_TTL_MS), value: vehicles });
  return result(vehicles);
}

export type IncidentType = "harshBraking" | "harshAcceleration" | "harshCornering" | "speeding";

export interface DrivingIncident {
  type: IncidentType;
  ts: Date;
  lat: number;
  lng: number;
  /** Human-readable specifics, as shown in the app. */
  detail: string;
}

const MAX_INCIDENTS = 500;

/** Where and when each incident happened (newest MAX_INCIDENTS, returned oldest -> newest). */
export async function getVehicleIncidents(
  deviceId: string,
  days: number,
  speedLimitKmh: number,
): Promise<DrivingIncident[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const ids = idList([deviceId]);

  const { rows } = await db.execute<{
    type: IncidentType;
    ts: Date;
    lat: number;
    lng: number;
    from_speed: number | null;
    speed: number;
    angle_delta: number | null;
  }>(sql`
    with ${pairsCte(ids, from, to)}, r as (
      select *, sum(case when speed > ${speedLimitKmh} and not coalesce(p_speed > ${speedLimitKmh}, false) then 1 else 0 end)
                  over (order by ts) as run_id
      from t
    ), sustained as (
      select run_id from r where speed > ${speedLimitKmh}
      group by run_id having extract(epoch from (max(ts) - min(ts))) >= ${MIN_SPEEDING_STRETCH_S}
    ), peaks as (
      select distinct on (r.run_id) r.ts, r.lat, r.lng, r.speed
      from r join sustained using (run_id)
      where r.speed > ${speedLimitKmh}
      order by r.run_id, r.speed desc
    ), events as (
      select 'harshBraking' as type, ts, lat, lng, p_speed as from_speed, speed, null::float as angle_delta from t where ${isBraking}
      union all
      select 'harshAcceleration', ts, lat, lng, p_speed, speed, null from t where ${isAcceleration}
      union all
      select 'harshCornering', ts, lat, lng, null, speed, angle_delta from t where ${isCornering}
      union all
      select 'speeding', ts, lat, lng, null, speed, null from peaks
    )
    select * from events order by ts desc limit ${MAX_INCIDENTS}
  `);

  return rows
    .map((r): DrivingIncident => {
      const detail =
        r.type === "harshCornering"
          ? `Giro de ${Math.round(r.angle_delta ?? 0)}° a ${Math.round(r.speed)} km/h`
          : r.type === "speeding"
            ? `${Math.round(r.speed)} km/h (límite ${speedLimitKmh})`
            : `${Math.round(r.from_speed ?? 0)} → ${Math.round(r.speed)} km/h`;
      return { type: r.type, ts: new Date(r.ts), lat: r.lat, lng: r.lng, detail };
    })
    .reverse();
}
