import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { positions, tollPassages, tollPlazas, vehicles, type TollPlaza } from "../db/schema/index.js";
import { PointGrid, segmentLengthMeters, segmentPointDistance } from "./tollGeometry.js";

/**
 * Detects when a vehicle's track passes through a toll station. Runs inline as each new
 * position is stored (never re-scans history): the new point is compared with the
 * vehicle's previous one, and the segment between them is checked against the stations
 * nearby. Stations live in memory (~1,000 rows), so a position costs no DB query unless
 * it actually hits a toll.
 */

// Measured to the nearest physical gate of a station (not its centroid), so it can be tight
// enough to ignore a mainline running 150-300 m from a junction's toll plaza.
const DETECTION_RADIUS_M = 100;
// Two reports further apart than this say nothing reliable about the road in between.
const MAX_GAP_MS = 10 * 60_000;
// A parked vehicle's GPS jitter must not count as driving past a station next to it.
const MIN_AVG_SPEED_MS = 8 / 3.6;
// Same vehicle + same station inside this window is one pass (queues, GPS bursts).
const DEDUPE_WINDOW_MS = 10 * 60_000;
// OSM often draws one station as two clusters (e.g. entry and exit lanes 500-700 m apart);
// same name + this close is the same station.
const SAME_STATION_MAX_M = 2000;
// A report this close to a gate tells us how fast the vehicle was going where it matters.
const SPEED_CHECK_RADIUS_M = 150;
// Toll lanes force a slowdown (Telepass lanes are limited to 30 km/h). A vehicle still going
// faster than this right next to the gates is on the adjacent mainline, not through the plaza.
const CRUISING_SPEED_KMH = 70;
// Name the seed gives stations OSM left unnamed — says nothing about *which* station.
const UNNAMED_PLAZA = "Peaje sin identificar";
const PLAZA_CACHE_TTL_MS = 6 * 60 * 60_000;
// Grid search padding (degrees): station cluster radius (250 m) + detection radius, at any Italian latitude.
const GRID_MARGIN_DEG = 0.006;

export interface TrackPoint {
  lat: number;
  lng: number;
  ts: Date;
  /** km/h */
  speed: number;
}

export interface PlazaHit {
  plaza: TollPlaza;
  ts: Date;
  distanceM: number;
  /** true when a report near the gates showed the vehicle slowed down through them; false
   * when reports were too sparse near the station to tell either way. */
  confirmed: boolean;
}

function nearestGateMeters(point: TrackPoint, gates: Array<[number, number]>): number {
  let nearest = Infinity;
  for (const [lat, lng] of gates) nearest = Math.min(nearest, segmentLengthMeters(point, { lat, lng }));
  return nearest;
}

type StationRef = Pick<TollPlaza, "id" | "name" | "lat" | "lng">;

function sameStation(a: StationRef, b: StationRef): boolean {
  if (a.id === b.id) return true;
  return a.name !== UNNAMED_PLAZA && a.name === b.name && segmentLengthMeters(a, b) <= SAME_STATION_MAX_M;
}

/** Pure: which stations does the track prev → points[…] pass through, in time order. */
export function findPlazaHits(
  prev: TrackPoint | undefined,
  points: TrackPoint[],
  grid: PointGrid<TollPlaza>,
): PlazaHit[] {
  const chain = prev ? [prev, ...points] : points;
  const hits: PlazaHit[] = [];

  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!;
    const b = chain[i]!;
    const dtMs = b.ts.getTime() - a.ts.getTime();
    if (dtMs <= 0 || dtMs > MAX_GAP_MS) continue;
    if (segmentLengthMeters(a, b) / (dtMs / 1000) < MIN_AVG_SPEED_MS) continue;

    for (const plaza of grid.near(a, b, GRID_MARGIN_DEG)) {
      const gates = plaza.points.length > 0 ? plaza.points : [[plaza.lat, plaza.lng] as [number, number]];
      let closest: { distanceM: number; t: number } | undefined;
      for (const [lat, lng] of gates) {
        const candidate = segmentPointDistance(a, b, { lat, lng });
        if (!closest || candidate.distanceM < closest.distanceM) closest = candidate;
      }
      if (!closest || closest.distanceM > DETECTION_RADIUS_M) continue;

      const nearGates = [a, b].filter((p) => nearestGateMeters(p, gates) <= SPEED_CHECK_RADIUS_M);
      if (nearGates.length > 0 && Math.min(...nearGates.map((p) => p.speed)) > CRUISING_SPEED_KMH) continue;

      hits.push({
        plaza,
        ts: new Date(a.ts.getTime() + closest.t * dtMs),
        distanceM: closest.distanceM,
        confirmed: nearGates.length > 0,
      });
    }
  }

  hits.sort((x, y) => x.ts.getTime() - y.ts.getTime());

  // Consecutive segments (or the two halves of one station) match the same pass — keep the
  // best evidence: a confirmed slowdown beats an unverified one, then the closest approach.
  const merged: PlazaHit[] = [];
  for (const hit of hits) {
    const existing = [...merged]
      .reverse()
      .find((m) => sameStation(m.plaza, hit.plaza) && hit.ts.getTime() - m.ts.getTime() <= DEDUPE_WINDOW_MS);
    if (!existing) {
      merged.push(hit);
      continue;
    }
    const better = hit.confirmed !== existing.confirmed ? hit.confirmed : hit.distanceM < existing.distanceM;
    if (better) Object.assign(existing, hit);
  }
  return merged;
}

let plazaCache: { grid: PointGrid<TollPlaza>; loadedAt: number } | undefined;
const lastPointByDevice = new Map<string, TrackPoint>();

async function getPlazaGrid(): Promise<PointGrid<TollPlaza>> {
  if (plazaCache && Date.now() - plazaCache.loadedAt < PLAZA_CACHE_TTL_MS) return plazaCache.grid;
  const rows = await db.select().from(tollPlazas);
  plazaCache = { grid: new PointGrid(rows), loadedAt: Date.now() };
  return plazaCache.grid;
}

async function fetchStoredPointBefore(deviceId: string, before: Date): Promise<TrackPoint | undefined> {
  const [row] = await db
    .select({ lat: positions.lat, lng: positions.lng, ts: positions.ts, speed: positions.speed })
    .from(positions)
    .where(and(eq(positions.deviceId, deviceId), lt(positions.ts, before)))
    .orderBy(desc(positions.ts))
    .limit(1);
  return row;
}

async function recordPassage(vehicleId: string, orgId: string, hit: PlazaHit): Promise<void> {
  const windowStart = new Date(hit.ts.getTime() - DEDUPE_WINDOW_MS);
  const windowEnd = new Date(hit.ts.getTime() + DEDUPE_WINDOW_MS);
  const recent = await db
    .select({
      id: tollPassages.id,
      confirmed: tollPassages.confirmed,
      plazaId: tollPlazas.id,
      name: tollPlazas.name,
      lat: tollPlazas.lat,
      lng: tollPlazas.lng,
    })
    .from(tollPassages)
    .innerJoin(tollPlazas, eq(tollPassages.plazaId, tollPlazas.id))
    .where(
      and(
        eq(tollPassages.vehicleId, vehicleId),
        gte(tollPassages.ts, windowStart),
        lte(tollPassages.ts, windowEnd),
      ),
    );

  const existing = recent.find((r) => sameStation({ id: r.plazaId, name: r.name, lat: r.lat, lng: r.lng }, hit.plaza));
  if (existing) {
    if (hit.confirmed && !existing.confirmed) {
      await db.update(tollPassages).set({ confirmed: true }).where(eq(tollPassages.id, existing.id));
    }
    return;
  }

  await db
    .insert(tollPassages)
    .values({ orgId, vehicleId, plazaId: hit.plaza.id, ts: hit.ts, confirmed: hit.confirmed });
}

/**
 * Call after (or alongside) storing `points` for a device. Never throws: a detection
 * problem must not break position ingestion.
 */
export async function detectTollPassages(deviceId: string, points: TrackPoint[]): Promise<void> {
  try {
    const valid = points
      .filter((p) => !(p.lat === 0 && p.lng === 0))
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());
    if (valid.length === 0) return;

    // Read + advance the in-memory cursor before the first await, so concurrent calls
    // for one device each see a consistent "previous point".
    const first = valid[0]!;
    const last = valid[valid.length - 1]!;
    const cached = lastPointByDevice.get(deviceId);
    const cursorUsable = cached !== undefined && cached.ts.getTime() < first.ts.getTime();
    if (!cached || cached.ts.getTime() < last.ts.getTime()) lastPointByDevice.set(deviceId, last);

    const prev = cursorUsable ? cached : await fetchStoredPointBefore(deviceId, first.ts);
    const grid = await getPlazaGrid();
    if (grid.size === 0) return;

    const hits = findPlazaHits(prev, valid, grid);
    if (hits.length === 0) return;

    const [vehicle] = await db
      .select({ id: vehicles.id, orgId: vehicles.orgId })
      .from(vehicles)
      .where(eq(vehicles.deviceId, deviceId))
      .limit(1);
    if (!vehicle) return;

    for (const hit of hits) await recordPassage(vehicle.id, vehicle.orgId, hit);
  } catch (err) {
    logger.error({ err, deviceId }, "Toll passage detection failed");
  }
}
