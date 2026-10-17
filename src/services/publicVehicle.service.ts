import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { DeviceEvent, Position } from "../db/schema/index.js";
import { AVL_ID } from "../tcp-server/codec8/avlIds.js";

/** The shapes exposed by the public /v1 API. They are deliberately separate from the
 * database rows: internal ids, priorities and org ids never leave through here, so the
 * tables can change without breaking the apps that integrate with us. */

export interface PublicPosition {
  ts: Date;
  lat: number;
  lng: number;
  speed: number;
  angle: number;
  altitude: number;
  satellites: number | null;
  /** null when the source doesn't report ignition. */
  ignition: boolean | null;
  /** Raw device IO elements (AVL ID -> value). Which ones exist depends on the device. */
  ioData: Record<string, number | string>;
}

export interface PublicVehicle {
  id: string;
  name: string;
  plate: string | null;
  fleetGroup: string | null;
  lastPosition: PublicPosition | null;
}

export function ignitionFrom(ioData: Record<string, number | string> | null | undefined): boolean | null {
  const value = ioData?.[String(AVL_ID.IGNITION)];
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

export function toPublicPosition(position: Pick<Position, "ts" | "lat" | "lng" | "speed" | "angle" | "altitude" | "satellites" | "ioData">): PublicPosition {
  const ioData = (position.ioData ?? {}) as Record<string, number | string>;
  return {
    ts: position.ts,
    lat: position.lat,
    lng: position.lng,
    speed: position.speed,
    angle: position.angle,
    altitude: position.altitude,
    satellites: position.satellites,
    ignition: ignitionFrom(ioData),
    ioData,
  };
}

export function toPublicEvent(event: Pick<DeviceEvent, "ts" | "type" | "payload">) {
  return { ts: event.ts, type: event.type, payload: event.payload };
}

interface VehicleRow extends Record<string, unknown> {
  id: string;
  name: string;
  plate: string | null;
  fleet_group: string | null;
  p_ts: Date | null;
  p_lat: number | null;
  p_lng: number | null;
  p_speed: number | null;
  p_angle: number | null;
  p_altitude: number | null;
  p_satellites: number | null;
  p_io_data: Record<string, number | string> | null;
}

function rowToVehicle(row: VehicleRow): PublicVehicle {
  return {
    id: row.id,
    name: row.name,
    plate: row.plate,
    fleetGroup: row.fleet_group,
    lastPosition:
      row.p_ts === null
        ? null
        : toPublicPosition({
            ts: row.p_ts,
            lat: row.p_lat!,
            lng: row.p_lng!,
            speed: row.p_speed!,
            angle: row.p_angle!,
            altitude: row.p_altitude!,
            satellites: row.p_satellites,
            ioData: row.p_io_data ?? {},
          }),
  };
}

/** Vehicles with their latest position in one query — a lateral lookup per vehicle that
 * uses the (device_id, ts DESC) index, instead of one request per vehicle. */
export async function listPublicVehicles(
  orgId: string,
  { vehicleId, allowedArea }: { vehicleId?: string; allowedArea?: string | null } = {},
): Promise<PublicVehicle[]> {
  // The newest report, with the last known location (7 days back at most) filled in when that
  // report has no GPS fix; a vehicle that has no location at all comes out with no position.
  const { rows } = await db.execute<VehicleRow>(sql`
    select v.id, v.name, v.plate, v.fleet_group,
           case when n.ts is null or (n.lat = 0 and n.lng = 0 and f.ts is null) then null else n.ts end as p_ts,
           case when n.lat = 0 and n.lng = 0 then f.lat else n.lat end as p_lat,
           case when n.lat = 0 and n.lng = 0 then f.lng else n.lng end as p_lng,
           n.speed as p_speed,
           case when n.lat = 0 and n.lng = 0 then f.angle else n.angle end as p_angle,
           case when n.lat = 0 and n.lng = 0 then f.altitude else n.altitude end as p_altitude,
           n.satellites as p_satellites, n.io_data as p_io_data
    from vehicles v
    left join lateral (
      select ts, lat, lng, speed, angle, altitude, satellites, io_data
      from positions
      where device_id = v.device_id
      order by ts desc
      limit 1
    ) n on true
    left join lateral (
      select ts, lat, lng, angle, altitude
      from positions
      where device_id = v.device_id and (lat <> 0 or lng <> 0)
        and ts >= n.ts - interval '7 days' and ts <= n.ts
      order by ts desc
      limit 1
    ) f on (n.lat = 0 and n.lng = 0)
    where v.org_id = ${orgId}
      ${vehicleId ? sql`and v.id = ${vehicleId}` : sql``}
      ${allowedArea ? sql`and v.fleet_group = ${allowedArea}` : sql``}
    order by v.name
  `);
  return rows.map(rowToVehicle);
}
