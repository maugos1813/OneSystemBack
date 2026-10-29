import { and, asc, between, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { driverBeacons, positions, vehicles } from "../db/schema/index.js";
import { BEACON_ID_PATTERN, parseBeaconPayload, type BeaconReading } from "./beaconParser.js";
import { identifyDrivers, type DriverCandidate, type Scan } from "./driverIdentification.js";
import { getVehicleForOrg } from "./vehicle.service.js";

export class DriverBeaconError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const MAX_SCAN_ROWS = 200_000;

interface VehicleRef {
  id: string;
  name: string;
  plate: string | null;
}

interface Loaded {
  scans: Scan[];
  vehicles: Map<string, VehicleRef>;
}

/** Every report of the org's vehicles that carries a beacon list in [from, to]; the parts of one scan are merged. */
async function loadScans(orgId: string, from: Date, to: Date): Promise<Loaded> {
  const rows = await db
    .select({
      vehicleId: vehicles.id,
      name: vehicles.name,
      plate: vehicles.plate,
      ts: positions.ts,
      speed: positions.speed,
      hex: sql<string>`${positions.ioData}->>'385'`,
    })
    .from(positions)
    .innerJoin(vehicles, eq(vehicles.deviceId, positions.deviceId))
    .where(and(eq(vehicles.orgId, orgId), between(positions.ts, from, to), isNotNull(vehicles.deviceId), sql`${positions.ioData} ? '385'`))
    .orderBy(asc(positions.ts))
    .limit(MAX_SCAN_ROWS);

  const refs = new Map<string, VehicleRef>();
  const scans = new Map<string, Scan>();
  for (const row of rows) {
    refs.set(row.vehicleId, { id: row.vehicleId, name: row.name, plate: row.plate });
    const key = `${row.vehicleId}|${row.ts.getTime()}`;
    const scan = scans.get(key) ?? { vehicleId: row.vehicleId, ts: row.ts.getTime(), speedKmh: row.speed, beacons: [] as BeaconReading[] };
    scan.speedKmh = Math.max(scan.speedKmh, row.speed);
    scan.beacons.push(...parseBeaconPayload(row.hex));
    scans.set(key, scan);
  }
  return { scans: [...scans.values()], vehicles: refs };
}

export function listRegisteredBeacons(orgId: string) {
  return db.select().from(driverBeacons).where(eq(driverBeacons.orgId, orgId)).orderBy(asc(driverBeacons.driverName));
}

export interface DetectedBeacon {
  beaconId: string;
  /** Driver the beacon is registered to, null while it is not registered. */
  driverName: string | null;
  registeredId: string | null;
  lastSeen: string;
  vehicle: VehicleRef;
  /** Mean RSSI over the period, in dBm. */
  avgRssi: number | null;
  sightings: number;
}

/**
 * The beacons the org's trackers heard in the last `hours`, each with who it belongs to if anyone: how an admin
 * finds the id of a new driver's beacon (bring it next to a tracker and it shows up here) and checks they are heard.
 */
export async function listDetectedBeacons(orgId: string, hours: number, now: Date = new Date()): Promise<DetectedBeacon[]> {
  const { scans, vehicles: refs } = await loadScans(orgId, new Date(now.getTime() - hours * 3_600_000), now);
  const registered = new Map((await listRegisteredBeacons(orgId)).map((b) => [b.beaconId, b]));

  const seen = new Map<string, { last: number; vehicleId: string; rssis: number[]; n: number }>();
  for (const scan of scans) {
    for (const b of scan.beacons) {
      const entry = seen.get(b.id) ?? { last: 0, vehicleId: scan.vehicleId, rssis: [], n: 0 };
      entry.n += 1;
      if (b.rssi !== null) entry.rssis.push(b.rssi);
      if (scan.ts >= entry.last) {
        entry.last = scan.ts;
        entry.vehicleId = scan.vehicleId;
      }
      seen.set(b.id, entry);
    }
  }

  return [...seen]
    .map(([beaconId, e]): DetectedBeacon => {
      const reg = registered.get(beaconId);
      return {
        beaconId,
        driverName: reg?.driverName ?? null,
        registeredId: reg?.id ?? null,
        lastSeen: new Date(e.last).toISOString(),
        vehicle: refs.get(e.vehicleId)!,
        avgRssi: e.rssis.length > 0 ? Math.round((e.rssis.reduce((a, b) => a + b, 0) / e.rssis.length) * 10) / 10 : null,
        sightings: e.n,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export async function createBeacon(orgId: string, input: { beaconId: string; driverName: string }) {
  const beaconId = input.beaconId.trim().toLowerCase();
  if (!BEACON_ID_PATTERN.test(beaconId)) throw new DriverBeaconError(400, "Identificador de baliza inválido");
  const [row] = await db
    .insert(driverBeacons)
    .values({ orgId, beaconId, driverName: input.driverName.trim() })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new DriverBeaconError(409, "Esa baliza ya está asignada");
  return row;
}

export async function renameBeacon(orgId: string, id: string, driverName: string) {
  const [row] = await db
    .update(driverBeacons)
    .set({ driverName: driverName.trim() })
    .where(and(eq(driverBeacons.id, id), eq(driverBeacons.orgId, orgId)))
    .returning();
  if (!row) throw new DriverBeaconError(404, "Baliza no encontrada");
  return row;
}

export async function deleteBeacon(orgId: string, id: string): Promise<void> {
  const rows = await db
    .delete(driverBeacons)
    .where(and(eq(driverBeacons.id, id), eq(driverBeacons.orgId, orgId)))
    .returning({ id: driverBeacons.id });
  if (rows.length === 0) throw new DriverBeaconError(404, "Baliza no encontrada");
}

export interface NamedDriver extends DriverCandidate {
  name: string;
}

export interface VehicleDriverView {
  vehicleId: string;
  from: string;
  to: string;
  movingScans: number;
  confidence: "high" | "low" | null;
  driver: NamedDriver | null;
  /** Other registered drivers heard steadily in the cab. */
  others: NamedDriver[];
}

/**
 * Who drove this vehicle in [from, to]. The whole organization is evaluated together so that a beacon heard by two
 * moving vehicles at once goes to the one that hears it loudest.
 */
export async function getVehicleDriver(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  from: Date,
  to: Date,
): Promise<VehicleDriverView> {
  const vehicle = await getVehicleForOrg(orgId, vehicleId, allowedArea);
  if (!vehicle) throw new DriverBeaconError(404, "Vehicle not found");

  const registered = await listRegisteredBeacons(orgId);
  const names = new Map(registered.map((b) => [b.beaconId, b.driverName]));
  const { scans } = await loadScans(orgId, from, to);
  const result = identifyDrivers(scans, new Set(names.keys())).get(vehicleId);

  const named = (c: DriverCandidate): NamedDriver => ({ ...c, name: names.get(c.beaconId)! });
  return {
    vehicleId,
    from: from.toISOString(),
    to: to.toISOString(),
    movingScans: result?.movingScans ?? 0,
    confidence: result?.confidence ?? null,
    driver: result?.driver ? named(result.driver) : null,
    others: (result?.others ?? []).map(named),
  };
}
