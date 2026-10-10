import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listVehiclesForOrg } from "./vehicle.service.js";

/**
 * Driving-style scores for the public API. The rules are the same ones the Conducción page
 * applies in the browser (OneSystemFront: lib/drivingStyle.ts + lib/drivingBehavior.ts) — keep
 * the constants below in sync with it. They run as one aggregate query inside Postgres, so
 * a request ships a handful of counts instead of every GPS sample over the wire.
 */

/** Estimated from consecutive GPS samples, like the app does. */
const SPEED_DELTA_THRESHOLD_KMH = 20;
const CORNERING_ANGLE_THRESHOLD_DEG = 45;
const MIN_SPEED_FOR_CORNERING_KMH = 20;
const MAX_SAMPLE_GAP_MS = 15_000;
const POINTS_PER_INCIDENT = 6;

export const DEFAULT_SPEED_LIMIT_KMH = 120;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;

export interface IncidentCounts {
  harshBraking: number;
  harshAcceleration: number;
  harshCornering: number;
  speeding: number;
}

export interface DrivingScores extends IncidentCounts {
  overall: number;
}

/** 1-100, where 100 is spotless — never 0, matching the app's rings. */
function scoreFromIncidentCount(count: number): number {
  return Math.max(1, Math.min(100, 100 - count * POINTS_PER_INCIDENT));
}

export function scoreGrade(score: number): "A+" | "A" | "B" | "C" | "D" {
  if (score >= 90) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

export function computeScores(counts: IncidentCounts): DrivingScores {
  const harshBraking = scoreFromIncidentCount(counts.harshBraking);
  const harshAcceleration = scoreFromIncidentCount(counts.harshAcceleration);
  const harshCornering = scoreFromIncidentCount(counts.harshCornering);
  const speeding = scoreFromIncidentCount(counts.speeding);
  const overall = Math.round((harshBraking + harshAcceleration + harshCornering + speeding) / 4);
  return { harshBraking, harshAcceleration, harshCornering, speeding, overall };
}

export interface VehicleDrivingStyle {
  vehicleId: string;
  name: string;
  plate: string | null;
  fleetGroup: string | null;
  /** GPS reports analysed in the period. 0 means there is no data, not perfect driving. */
  samples: number;
  /** null when there were no reports in the period. */
  scores: (DrivingScores & { grade: string }) | null;
  incidents: IncidentCounts;
}

interface DeviceCounts extends IncidentCounts {
  samples: number;
}

async function queryCounts(deviceIds: string[], from: Date, to: Date, speedLimitKmh: number): Promise<Map<string, DeviceCounts>> {
  if (deviceIds.length === 0) return new Map();
  const ids = sql.join(
    deviceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const { rows } = await db.execute<{
    device_id: string;
    samples: number;
    harsh_braking: number;
    harsh_acceleration: number;
    harsh_cornering: number;
    speeding: number;
  }>(sql`
    with s as (
      select device_id, ts, speed, angle,
             lag(ts) over w as p_ts, lag(speed) over w as p_speed, lag(angle) over w as p_angle
      from positions
      where device_id in (${ids}) and ts >= ${from} and ts <= ${to}
      window w as (partition by device_id order by ts)
    ), t as (
      select device_id, speed, angle, p_speed, p_angle,
             extract(epoch from (ts - p_ts)) * 1000 as dt_ms,
             least(abs(angle - p_angle), 360 - abs(angle - p_angle)) as angle_delta
      from s
    )
    select device_id,
           count(*)::int as samples,
           (count(*) filter (where dt_ms > 0 and dt_ms <= ${MAX_SAMPLE_GAP_MS}
                             and speed - p_speed <= ${-SPEED_DELTA_THRESHOLD_KMH}))::int as harsh_braking,
           (count(*) filter (where dt_ms > 0 and dt_ms <= ${MAX_SAMPLE_GAP_MS}
                             and speed - p_speed >= ${SPEED_DELTA_THRESHOLD_KMH}))::int as harsh_acceleration,
           (count(*) filter (where dt_ms > 0 and dt_ms <= ${MAX_SAMPLE_GAP_MS}
                             and p_speed >= ${MIN_SPEED_FOR_CORNERING_KMH} and speed >= ${MIN_SPEED_FOR_CORNERING_KMH}
                             and angle_delta >= ${CORNERING_ANGLE_THRESHOLD_DEG}))::int as harsh_cornering,
           -- a continuous stretch over the limit is one incident: count where each stretch starts
           (count(*) filter (where speed > ${speedLimitKmh} and not coalesce(p_speed > ${speedLimitKmh}, false)))::int as speeding
    from t
    group by device_id
  `);

  return new Map(
    rows.map((r) => [
      r.device_id,
      {
        samples: r.samples,
        harshBraking: r.harsh_braking,
        harshAcceleration: r.harsh_acceleration,
        harshCornering: r.harsh_cornering,
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
  days: number;
  speedLimitKmh: number;
}

export interface DrivingStyleResult {
  days: number;
  speedLimitKmh: number;
  from: Date;
  to: Date;
  vehicles: VehicleDrivingStyle[];
}

export async function getDrivingStyle(query: DrivingStyleQuery): Promise<DrivingStyleResult> {
  const to = new Date();
  const from = new Date(to.getTime() - query.days * 24 * 60 * 60 * 1000);

  const fleet = (await listVehiclesForOrg(query.orgId, query.allowedArea)).filter(
    (v) => !query.vehicleId || v.id === query.vehicleId,
  );

  const cacheKey = `${query.orgId}|${query.allowedArea ?? ""}|${query.vehicleId ?? "*"}|${query.days}|${query.speedLimitKmh}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { days: query.days, speedLimitKmh: query.speedLimitKmh, from, to, vehicles: cached.value };
  }

  const deviceIds = fleet.flatMap((v) => (v.deviceId ? [v.deviceId] : []));
  const countsByDevice = await queryCounts(deviceIds, from, to, query.speedLimitKmh);

  const vehicles: VehicleDrivingStyle[] = fleet.map((v) => {
    const counts = v.deviceId ? countsByDevice.get(v.deviceId) : undefined;
    const incidents: IncidentCounts = {
      harshBraking: counts?.harshBraking ?? 0,
      harshAcceleration: counts?.harshAcceleration ?? 0,
      harshCornering: counts?.harshCornering ?? 0,
      speeding: counts?.speeding ?? 0,
    };
    const scores = counts ? computeScores(incidents) : null;
    return {
      vehicleId: v.id,
      name: v.name,
      plate: v.plate,
      fleetGroup: v.fleetGroup,
      samples: counts?.samples ?? 0,
      scores: scores ? { ...scores, grade: scoreGrade(scores.overall) } : null,
      incidents,
    };
  });

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: vehicles });
  return { days: query.days, speedLimitKmh: query.speedLimitKmh, from, to, vehicles };
}
