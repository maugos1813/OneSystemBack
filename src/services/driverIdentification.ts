import type { BeaconReading } from "./beaconParser.js";

/**
 * Who was driving: the pure rule behind it (no database). Each report of a tracker that heard beacons is a "scan".
 *  - Only scans taken while the vehicle moves count: a parked truck hears every beacon at a depot or a meeting.
 *  - A beacon heard by several moving vehicles in the same minute belongs to the one that hears it loudest, so two
 *    trucks side by side do not both claim the same driver.
 *  - A driver must be heard in most of the moving scans, not once in passing.
 *  - Of the drivers heard that steadily, the loudest is the probable driver and the rest are in the cab ("others").
 *    Signal strength between two people a metre apart is unreliable, so with more than one the answer is "low" confidence.
 */

export const MOVING_KMH = 10;
export const MIN_MOVING_SCANS = 3;
export const MIN_PRESENCE = 0.6;
const BUCKET_MS = 60_000;

export interface Scan {
  vehicleId: string;
  ts: number;
  speedKmh: number;
  beacons: BeaconReading[];
}

export interface DriverCandidate {
  beaconId: string;
  /** Share of the vehicle's moving scans in which this beacon was heard (0..1). */
  presence: number;
  /** Mean RSSI in dBm over the scans it was heard in (null when never reported). */
  avgRssi: number | null;
}

export interface VehicleDrivers {
  vehicleId: string;
  movingScans: number;
  driver: DriverCandidate | null;
  others: DriverCandidate[];
  /** "high": a single steady beacon. "low": several, the loudest is only the probable driver. null: nobody identified. */
  confidence: "high" | "low" | null;
}

const rssiOf = (r: BeaconReading): number => r.rssi ?? -127;

/** `registered`: the beacon ids that belong to a driver of this organization; any other beacon is ignored. */
export function identifyDrivers(scans: readonly Scan[], registered: ReadonlySet<string>): Map<string, VehicleDrivers> {
  const moving = scans.filter((s) => s.speedKmh >= MOVING_KMH);

  // Loudest vehicle for each (beacon, minute).
  const loudest = new Map<string, { vehicleId: string; rssi: number }>();
  for (const scan of moving) {
    const bucket = Math.floor(scan.ts / BUCKET_MS);
    for (const b of scan.beacons) {
      if (!registered.has(b.id)) continue;
      const key = `${b.id}|${bucket}`;
      const best = loudest.get(key);
      if (!best || rssiOf(b) > best.rssi) loudest.set(key, { vehicleId: scan.vehicleId, rssi: rssiOf(b) });
    }
  }

  const perVehicle = new Map<string, { scans: number; heard: Map<string, number[]> }>();
  for (const scan of moving) {
    const entry = perVehicle.get(scan.vehicleId) ?? { scans: 0, heard: new Map<string, number[]>() };
    entry.scans += 1;
    const bucket = Math.floor(scan.ts / BUCKET_MS);
    for (const b of scan.beacons) {
      if (!registered.has(b.id)) continue;
      if (loudest.get(`${b.id}|${bucket}`)?.vehicleId !== scan.vehicleId) continue;
      const list = entry.heard.get(b.id) ?? [];
      list.push(rssiOf(b));
      entry.heard.set(b.id, list);
    }
    perVehicle.set(scan.vehicleId, entry);
  }

  const results = new Map<string, VehicleDrivers>();
  for (const [vehicleId, { scans: count, heard }] of perVehicle) {
    const steady: DriverCandidate[] = [];
    if (count >= MIN_MOVING_SCANS) {
      for (const [beaconId, rssis] of heard) {
        const presence = rssis.length / count;
        if (presence < MIN_PRESENCE) continue;
        const reported = rssis.filter((r) => r > -127);
        const avgRssi = reported.length > 0 ? Math.round((reported.reduce((a, b) => a + b, 0) / reported.length) * 10) / 10 : null;
        steady.push({ beaconId, presence: Math.round(presence * 100) / 100, avgRssi });
      }
    }
    steady.sort((a, b) => (b.avgRssi ?? -127) - (a.avgRssi ?? -127) || b.presence - a.presence);
    results.set(vehicleId, {
      vehicleId,
      movingScans: count,
      driver: steady[0] ?? null,
      others: steady.slice(1),
      confidence: steady.length === 0 ? null : steady.length === 1 ? "high" : "low",
    });
  }
  return results;
}
