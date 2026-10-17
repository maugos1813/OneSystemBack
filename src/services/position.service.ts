import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
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
    records.map((record) => ({
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

export async function getLatestPosition(deviceId: string): Promise<Position | undefined> {
  const [row] = await db
    .select()
    .from(positions)
    .where(eq(positions.deviceId, deviceId))
    .orderBy(desc(positions.ts))
    .limit(1);
  return row;
}

export interface PositionHistoryQuery {
  deviceId: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function getPositionHistory({
  deviceId,
  from,
  to,
  limit = 500,
}: PositionHistoryQuery): Promise<Position[]> {
  const conditions = [eq(positions.deviceId, deviceId)];
  if (from) conditions.push(gte(positions.ts, from));
  if (to) conditions.push(lte(positions.ts, to));

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
