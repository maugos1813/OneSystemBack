import { describe, expect, it } from "vitest";
import { identifyDrivers, type Scan } from "../../src/services/driverIdentification.js";

const MARCO = "eddystone:aa-01";
const LUCA = "eddystone:aa-02";
const ANNA = "eddystone:aa-03";
const registered = new Set([MARCO, LUCA, ANNA]);
const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);

/** A report every 30 s for `minutes`, with the same beacons heard in each. */
function drive(vehicleId: string, minutes: number, beacons: Array<[string, number]>, speedKmh = 60, start = T0): Scan[] {
  return Array.from({ length: minutes * 2 }, (_, i) => ({
    vehicleId,
    ts: start + i * 30_000,
    speedKmh,
    beacons: beacons.map(([id, rssi]) => ({ id, rssi })),
  }));
}

describe("identifyDrivers", () => {
  it("names the one driver heard steadily while the vehicle moves", () => {
    const result = identifyDrivers(drive("v1", 10, [[MARCO, -62]]), registered).get("v1")!;
    expect(result.driver?.beaconId).toBe(MARCO);
    expect(result.others).toEqual([]);
    expect(result.confidence).toBe("high");
  });

  it("with two people in the cab, the loudest is the probable driver and the other rides along, with low confidence", () => {
    const result = identifyDrivers(drive("v1", 10, [[LUCA, -74], [MARCO, -62]]), registered).get("v1")!;
    expect(result.driver?.beaconId).toBe(MARCO);
    expect(result.others.map((o) => o.beaconId)).toEqual([LUCA]);
    expect(result.confidence).toBe("low");
  });

  it("identifies nobody for vehicles parked at a meeting, however many beacons they hear", () => {
    const meeting = ["v1", "v2", "v3"].flatMap((v) => drive(v, 30, [[MARCO, -60], [LUCA, -61], [ANNA, -62]], 0));
    const results = identifyDrivers(meeting, registered);
    for (const v of ["v1", "v2", "v3"]) expect(results.get(v)?.driver ?? null).toBeNull();
  });

  it("ignores a beacon heard only in passing (a truck going by, a driver walking past)", () => {
    const scans = [...drive("v1", 10, [[MARCO, -62]]), ...drive("v1", 10, [], 60, T0 + 10 * 60_000)];
    // MARCO is heard in 20 of 40 moving scans: 50% < 60%
    expect(identifyDrivers(scans, registered).get("v1")!.driver).toBeNull();
  });

  it("ignores beacons that are not registered to a driver", () => {
    const result = identifyDrivers(drive("v1", 10, [["eddystone:ff-ff", -50]]), registered).get("v1")!;
    expect(result.driver).toBeNull();
  });

  it("gives a beacon heard by two moving vehicles at once to the one that hears it loudest", () => {
    const scans = [...drive("near", 10, [[MARCO, -60]]), ...drive("far", 10, [[MARCO, -85]])];
    const results = identifyDrivers(scans, registered);
    expect(results.get("near")!.driver?.beaconId).toBe(MARCO);
    expect(results.get("far")!.driver).toBeNull();
  });

  it("lets the same driver appear in two vehicles one after the other", () => {
    const scans = [...drive("v1", 10, [[MARCO, -60]]), ...drive("v2", 10, [[MARCO, -60]], 60, T0 + 60 * 60_000)];
    const results = identifyDrivers(scans, registered);
    expect(results.get("v1")!.driver?.beaconId).toBe(MARCO);
    expect(results.get("v2")!.driver?.beaconId).toBe(MARCO);
  });

  it("needs a few moving reports before it names anyone", () => {
    expect(identifyDrivers(drive("v1", 1, [[MARCO, -60]]).slice(0, 2), registered).get("v1")!.driver).toBeNull();
  });
});
