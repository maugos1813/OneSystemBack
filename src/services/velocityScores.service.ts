import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { radiusAccessToken } from "./radiusVelocity.service.js";

/**
 * Radius Velocity's own driver-performance scores, exactly as its "Driver Performance" report shows them.
 *
 * Velocity's devices detect harsh braking / acceleration / cornering with their own accelerometer and Velocity scores each category
 * itself (the harsh ones are `100 − K × events per hour of driving`; speeding depends on more than the event count), so they cannot be
 * re-derived from the GPS positions we keep. We ask Velocity for the finished numbers instead, through the same endpoint its web report
 * uses, with the session this app already has with the account. If Velocity does not answer, the caller falls back to OneTrack's own
 * calculation: this module only ever returns data or null, never throws.
 */

const SUMMARY_URL = "https://www.velocityfleet.com/vapi/v2/telematics/driver-performance/scores/summary/";
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 50;
/** Velocity's reports are by calendar day, in the fleet's time. */
const REPORT_TIME_ZONE = "Europe/Rome";

export interface VelocityVehicleScores {
  /** Licence plate, upper-case without spaces. */
  plate: string;
  group: string | null;
  distanceKm: number;
  drivingHours: number;
  trips: number;
  overall: number;
  braking: number;
  acceleration: number;
  cornering: number;
  speeding: number;
  events: { braking: number; acceleration: number; cornering: number; speeding: number };
}

const cache = new Map<string, { expiresAt: number; value: Map<string, VelocityVehicleScores> }>();

/** "2026-10-26" for an instant, as the calendar day in Rome. */
export function reportDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const normalizePlate = (plate: unknown): string => (typeof plate === "string" ? plate.replace(/\s+/g, "").toUpperCase() : "");
const whole = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Pure: Velocity's response -> its scores by plate. Entries without a plate or a score are ignored. */
export function parseVelocitySummary(body: unknown): Map<string, VelocityVehicleScores> {
  const out = new Map<string, VelocityVehicleScores>();
  const rows = (body as { summaries?: unknown })?.summaries;
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const plate = normalizePlate(row.vehicle_registration);
    if (!plate || typeof row.driver_score !== "number") continue;
    out.set(plate, {
      plate,
      group: typeof row.vehicle_group === "string" ? row.vehicle_group : null,
      distanceKm: num(row.distance),
      drivingHours: num(row.duration) / 3600,
      trips: whole(row.number_of_journeys),
      overall: whole(row.driver_score),
      braking: whole(row.braking_score),
      acceleration: whole(row.accelerating_score),
      cornering: whole(row.cornering_score),
      speeding: whole(row.speeding_score),
      events: {
        braking: whole(row.braking_event_count),
        acceleration: whole(row.accelerating_event_count),
        cornering: whole(row.cornering_event_count),
        speeding: whole(row.speeding_event_count),
      },
    });
  }
  return out;
}

async function post(token: string, from: string, to: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(SUMMARY_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        customers: [env.RADIUS_VELOCITY_CUSTOMER_ID],
        kinesis_report_type: 3,
        kinesis_display_type: 21,
        search_by: 13,
        all_drivers: true,
        all_devices: true,
        // 2 = a specific date range (what the report's own "Custom date range" sends); the presets are 1.
        date_selection_type: 2,
        date_start: from,
        date_end: to,
        breakdown_type: "DAILY",
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Velocity's scores for the days that contain `from`..`to`, by plate; null when Velocity is not configured or does not answer.
 * (Velocity scores whole calendar days, so a window of "the last 24 hours" covers yesterday and today.)
 */
export async function fetchVelocityScores(from: Date, to: Date, now: number = Date.now()): Promise<Map<string, VelocityVehicleScores> | null> {
  if (!env.RADIUS_VELOCITY_REFRESH_TOKEN) return null;
  const dayFrom = reportDay(from);
  const dayTo = reportDay(to);
  const key = `${env.RADIUS_VELOCITY_CUSTOMER_ID}|${dayFrom}|${dayTo}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    let res = await post(await radiusAccessToken(), dayFrom, dayTo);
    // The session may have expired: ask for a fresh one once.
    if (res.status === 401 || res.status === 403) res = await post(await radiusAccessToken({ fresh: true }), dayFrom, dayTo);
    if (!res.ok) throw new Error(`Radius Velocity answered ${res.status}`);
    const scores = parseVelocitySummary(await res.json());
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { expiresAt: now + CACHE_TTL_MS, value: scores });
    return scores;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), dayFrom, dayTo }, "Could not read the driver scores of Radius Velocity");
    return null;
  }
}

/** For tests: forget what was remembered. */
export function clearVelocityScoresCache(): void {
  cache.clear();
}
