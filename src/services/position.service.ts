import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deviceEvents, positions, type DeviceEvent, type Position } from "../db/schema/index.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import { serializeIoElements } from "../tcp-server/codec8/ioSerialize.js";
import type { AvlRecord } from "../tcp-server/codec8/types.js";
import { DEVICE_ALARM_KEYS, DEVICE_ALARMS } from "./deviceAlarms.js";
import { detectTollPassages } from "./tollDetection.service.js";

const EVENT_AVL_IDS: ReadonlySet<number> = new Set([
  AVL_ID.IGNITION,
  AVL_ID.MOVEMENT,
  ...DEVICE_ALARM_KEYS.map((key) => DEVICE_ALARMS[key].avlId),
]);

/**
 * Persists every AVL record from a decoded packet as a position row, plus a
 * `device_events` row for any record whose Event IO ID is one we track explicitly
 * (e.g. ignition on/off). Runs as a single transaction so a packet is stored atomically.
 */
export async function storeAvlRecords(deviceId: string, records: AvlRecord[]): Promise<void> {
  if (records.length === 0) return;

  await db.transaction(async (tx) => {
    await tx.insert(positions).values(
      records.map((record) => ({
        deviceId,
        ts: record.timestamp,
        lat: record.gps.latitude,
        lng: record.gps.longitude,
        altitude: record.gps.altitude,
        angle: record.gps.angle,
        satellites: record.gps.satellites,
        speed: record.gps.speed,
        priority: record.priority,
        ioData: serializeIoElements(record.io),
      })),
    );

    const eventRows = records
      .filter((record) => EVENT_AVL_IDS.has(record.io.eventId))
      .map((record) => ({
        deviceId,
        ts: record.timestamp,
        type: eventTypeFromAvlId(record.io.eventId),
        payload: serializeIoElements(record.io),
      }));

    if (eventRows.length > 0) {
      await tx.insert(deviceEvents).values(eventRows);
    }
  });

  // Not awaited: the device's ack must not wait on toll detection (which never throws).
  void detectTollPassages(
    deviceId,
    records.filter((record) => hasFix({ lat: record.gps.latitude, lng: record.gps.longitude })).map((record) => ({
      lat: record.gps.latitude,
      lng: record.gps.longitude,
      ts: record.timestamp,
      speed: record.gps.speed,
    })),
  );
}

export function eventTypeFromAvlId(avlId: number): string {
  switch (avlId) {
    case AVL_ID.IGNITION:
      return "ignition_change";
    case AVL_ID.MOVEMENT:
      return "movement_change";
    default: {
      const alarm = DEVICE_ALARM_KEYS.map((key) => DEVICE_ALARMS[key]).find((a) => a.avlId === avlId);
      return alarm ? alarm.eventType : `avl_${avlId}`;
    }
  }
}

/**
 * A report with a GPS fix. A tracker that has no fix (indoors, just powered on) still reports,
 * with latitude and longitude 0/0 — a point in the Gulf of Guinea that must never be shown,
 * drawn or measured. Those reports are still stored: they carry voltage, signal and alarms.
 */
export function hasFix(position: { lat: number; lng: number }): boolean {
  return position.lat !== 0 || position.lng !== 0;
}

const WITH_FIX = sql`(${positions.lat} <> 0 or ${positions.lng} <> 0)`;

/** How far back the last known location is looked up when the newest report has no fix. Kept to
 * the uncompressed part of the table so a device that never gets a fix cannot make every poll
 * scan its whole history. */
const LAST_FIX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The newest report as it is, fix or not — for what it carries besides the location (IO data). */
export async function getLatestReading(deviceId: string): Promise<Position | undefined> {
  const [row] = await db
    .select()
    .from(positions)
    .where(eq(positions.deviceId, deviceId))
    .orderBy(desc(positions.ts))
    .limit(1);
  return row;
}

/**
 * The latest position of a device: the newest report, with the last known location filled in
 * when that report has no fix (what trackers do themselves). Undefined when the device has no
 * location to show at all — it has never had a fix, or not within the last 7 days.
 */
export async function getLatestPosition(deviceId: string): Promise<Position | undefined> {
  const newest = await getLatestReading(deviceId);
  if (!newest || hasFix(newest)) return newest;

  const [lastFix] = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.deviceId, deviceId),
        WITH_FIX,
        gte(positions.ts, new Date(newest.ts.getTime() - LAST_FIX_LOOKBACK_MS)),
      ),
    )
    .orderBy(desc(positions.ts))
    .limit(1);
  if (!lastFix) return undefined;
  return { ...newest, lat: lastFix.lat, lng: lastFix.lng, altitude: lastFix.altitude, angle: lastFix.angle };
}

export interface PositionHistoryQuery {
  deviceId: string;
  from?: Date;
  to?: Date;
  limit?: number;
  /** Spreads at most this many points over the whole range (oldest to newest) instead of cutting it at the newest `limit`. */
  maxPoints?: number;
}

/**
 * The timestamps to keep so a long range fits `maxPoints`: the range is cut into runs of equal length and the fastest report of each
 * run stays (the first and last one always do), so the route keeps its shape and no speeding peak disappears with the thinning.
 */
export function thinningKeep(rows: Array<{ ts: Date; speed: number }>, maxPoints: number): Date[] {
  if (rows.length <= maxPoints) return rows.map((row) => row.ts);
  const run = Math.ceil(rows.length / maxPoints);
  const keep: Date[] = [];
  for (let start = 0; start < rows.length; start += run) {
    let best = rows[start]!;
    for (const row of rows.slice(start, start + run)) if (row.speed > best.speed) best = row;
    keep.push(best.ts);
  }
  // The route starts and ends where the vehicle did, not at the fastest point of its first and last run.
  keep[0] = rows[0]!.ts;
  keep[keep.length - 1] = rows[rows.length - 1]!.ts;
  return keep;
}

export async function getPositionHistory({
  deviceId,
  from,
  to,
  limit = 500,
  maxPoints,
}: PositionHistoryQuery): Promise<Position[]> {
  const conditions = [eq(positions.deviceId, deviceId), WITH_FIX];
  if (from) conditions.push(gte(positions.ts, from));
  if (to) conditions.push(lte(positions.ts, to));

  if (maxPoints) {
    const light = await db
      .select({ ts: positions.ts, speed: positions.speed })
      .from(positions)
      .where(and(...conditions))
      .orderBy(asc(positions.ts));
    const keep = thinningKeep(light, Math.min(maxPoints, 5000));
    if (keep.length === 0) return [];
    return db
      .select()
      .from(positions)
      .where(and(eq(positions.deviceId, deviceId), inArray(positions.ts, keep)))
      .orderBy(desc(positions.ts));
  }

  return db
    .select()
    .from(positions)
    .where(and(...conditions))
    .orderBy(desc(positions.ts))
    .limit(Math.min(limit, 5000));
}

export interface DeviceEventsQuery {
  deviceId: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function getDeviceEvents({
  deviceId,
  from,
  to,
  limit = 100,
}: DeviceEventsQuery): Promise<DeviceEvent[]> {
  const conditions = [eq(deviceEvents.deviceId, deviceId)];
  if (from) conditions.push(gte(deviceEvents.ts, from));
  if (to) conditions.push(lte(deviceEvents.ts, to));

  return db
    .select()
    .from(deviceEvents)
    .where(and(...conditions))
    .orderBy(desc(deviceEvents.ts))
    .limit(Math.min(limit, 1000));
}

/** The newest event of each tracker-alarm type for a device (what decides whether the alarm
 * is currently raised). Keyed by event type; types that never happened are absent. */
export async function getLatestAlarmEvents(deviceId: string): Promise<Map<string, DeviceEvent>> {
  const types = DEVICE_ALARM_KEYS.map((key) => DEVICE_ALARMS[key].eventType);
  const rows = await db
    .selectDistinctOn([deviceEvents.type])
    .from(deviceEvents)
    .where(and(eq(deviceEvents.deviceId, deviceId), inArray(deviceEvents.type, types)))
    .orderBy(deviceEvents.type, desc(deviceEvents.ts));
  return new Map(rows.map((row) => [row.type, row]));
}
