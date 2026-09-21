import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { deviceEvents, positions, type Position } from "../db/schema/index.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";
import { serializeIoElements } from "../tcp-server/codec8/ioSerialize.js";
import type { AvlRecord } from "../tcp-server/codec8/types.js";

const EVENT_AVL_IDS: ReadonlySet<number> = new Set([AVL_ID.IGNITION, AVL_ID.MOVEMENT]);

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
}

function eventTypeFromAvlId(avlId: number): string {
  switch (avlId) {
    case AVL_ID.IGNITION:
      return "ignition_change";
    case AVL_ID.MOVEMENT:
      return "movement_change";
    default:
      return `avl_${avlId}`;
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
