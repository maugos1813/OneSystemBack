import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reports without a GPS fix (latitude and longitude both 0) against a real in-memory Postgres:
 * they stay in the table (they carry voltage, signal, alarms) but are never shown as a place.
 */

const harness = vi.hoisted(() => ({ tollCalls: [] as unknown[][] }));

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/services/tollDetection.service.js", () => ({
  detectTollPassages: async (...args: unknown[]) => {
    harness.tollCalls.push(args);
  },
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const position = await import("../../src/services/position.service.js");
const { listPublicVehicles } = await import("../../src/services/publicVehicle.service.js");
const { queryStats } = await import("../../src/services/drivingStyle.service.js");
const { positions, deviceEvents } = await import("../../src/db/schema/index.js");
const { db } = clientModule;
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000000a";
const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const VEHICLE = "00000000-0000-0000-0000-0000000000a1";
const T0 = new Date("2026-10-17T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY);
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0,
      angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0,
      priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts)
    );
    CREATE TABLE device_events (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      type varchar(50) NOT NULL, payload jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts)
    );
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20),
      fleet_group varchar(50), device_id uuid
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM positions; DELETE FROM device_events; DELETE FROM vehicles; DELETE FROM devices;");
  await pg.exec(`INSERT INTO devices VALUES ('${DEVICE}'); INSERT INTO vehicles VALUES ('${VEHICLE}', '${ORG}', 'VAN-1', null, null, '${DEVICE}');`);
  harness.tollCalls.length = 0;
});

async function report(ts: Date, lat: number, lng: number, extra: { speed?: number; io?: Record<string, number>; angle?: number } = {}) {
  await db.insert(positions).values({
    deviceId: DEVICE,
    ts,
    lat,
    lng,
    altitude: lat === 0 ? 0 : 120,
    angle: extra.angle ?? (lat === 0 ? 0 : 90),
    satellites: lat === 0 ? 0 : 9,
    speed: extra.speed ?? 0,
    priority: 0,
    ioData: extra.io ?? {},
  });
}

describe("hasFix", () => {
  it("is false only for exactly 0/0", () => {
    expect(position.hasFix({ lat: 0, lng: 0 })).toBe(false);
    expect(position.hasFix({ lat: 45.4, lng: 9.2 })).toBe(true);
    expect(position.hasFix({ lat: 0, lng: 9.2 })).toBe(true); // on the equator, a real place
    expect(position.hasFix({ lat: 51.5, lng: 0 })).toBe(true); // on the prime meridian
  });
});

describe("getLatestPosition", () => {
  it("returns the newest report when it has a fix", async () => {
    await report(at(0), 45.1, 9.1);
    await report(at(1), 45.2, 9.2);
    expect(await position.getLatestPosition(DEVICE)).toMatchObject({ lat: 45.2, lng: 9.2 });
  });

  it("keeps the newest report's data but fills in the last known location when it has no fix", async () => {
    await report(at(0), 45.1, 9.1, { angle: 180 });
    await report(at(5), 0, 0, { io: { "66": 12462, "239": 0 } });
    const latest = await position.getLatestPosition(DEVICE);
    expect(latest).toMatchObject({ lat: 45.1, lng: 9.1, altitude: 120, angle: 180, satellites: 0, ioData: { "66": 12462, "239": 0 } });
    expect(latest!.ts).toEqual(at(5)); // still the time of the newest report, with its fresh voltage
  });

  it("has no position at all for a device that never had a fix", async () => {
    await report(at(0), 0, 0, { io: { "66": 12400 } });
    await report(at(1), 0, 0, { io: { "66": 12500 } });
    expect(await position.getLatestPosition(DEVICE)).toBeUndefined();
    expect(await position.getLatestPosition("00000000-0000-0000-0000-0000000000ff")).toBeUndefined();
  });

  it("does not reach back more than 7 days for a location", async () => {
    await report(new Date(T0.getTime() - 8 * 86_400_000), 45.1, 9.1);
    await report(T0, 0, 0);
    expect(await position.getLatestPosition(DEVICE)).toBeUndefined();
    await report(new Date(T0.getTime() - 6 * 86_400_000), 45.3, 9.3);
    expect(await position.getLatestPosition(DEVICE)).toMatchObject({ lat: 45.3, lng: 9.3 });
  });
});

describe("getLatestReading", () => {
  it("returns the newest report as it is, even with no fix", async () => {
    await report(at(0), 45.1, 9.1);
    await report(at(1), 0, 0, { io: { "16": 123 } });
    expect(await position.getLatestReading(DEVICE)).toMatchObject({ lat: 0, lng: 0, ioData: { "16": 123 } });
  });
});

describe("getPositionHistory", () => {
  it("leaves out the reports without a fix, so no route is drawn to 0/0", async () => {
    await report(at(0), 45.1, 9.1);
    await report(at(1), 0, 0);
    await report(at(2), 45.2, 9.2);
    await report(at(3), 0, 0);
    const history = await position.getPositionHistory({ deviceId: DEVICE });
    expect(history.map((p) => p.lat)).toEqual([45.2, 45.1]);
  });
});

describe("public API vehicle list", () => {
  const lastPositionOf = async () => (await listPublicVehicles(ORG))[0]!.lastPosition;

  it("shows the last known location when the newest report has no fix, with the newest data", async () => {
    await report(at(0), 45.1, 9.1);
    await report(at(5), 0, 0, { io: { "66": 12462 } });
    const last = await lastPositionOf();
    expect(last).toMatchObject({ lat: 45.1, lng: 9.1 });
    expect(JSON.stringify(last)).toContain("12462");
  });

  it("shows no position for a vehicle that has never had a fix", async () => {
    await report(at(0), 0, 0);
    expect(await lastPositionOf()).toBeNull();
  });

  it("is unchanged when the newest report has a fix, and null with no reports at all", async () => {
    expect(await lastPositionOf()).toBeNull();
    await report(at(0), 45.1, 9.1);
    await report(at(1), 45.2, 9.2);
    expect(await lastPositionOf()).toMatchObject({ lat: 45.2, lng: 9.2 });
  });

  it("ignores a location older than 7 days", async () => {
    await report(new Date(T0.getTime() - 8 * 86_400_000), 45.1, 9.1);
    await report(T0, 0, 0);
    expect(await lastPositionOf()).toBeNull();
  });
});

describe("driving style", () => {
  it("measures the same trip with or without no-fix reports mixed in", async () => {
    const M_PER_DEG = 111_320;
    const start = T0.getTime();
    // 15 minutes at 90 km/h, a report every 4 s: about 22 km
    let lat = 45;
    for (let t = 0; t <= 900; t += 4) {
      await report(new Date(start + t * 1000), lat, 9, { speed: 90 });
      lat += ((90 / 3.6) * 4) / M_PER_DEG;
    }
    const clean = (await queryStats([DEVICE], T0, new Date(start + 900_000), 130)).get(DEVICE)!;

    // the same trip, with a no-fix report between every pair
    for (let t = 2; t < 900; t += 4) await report(new Date(start + t * 1000), 0, 0, { speed: 0 });
    const mixed = (await queryStats([DEVICE], T0, new Date(start + 900_000), 130)).get(DEVICE)!;

    expect(clean.distanceKm).toBeGreaterThan(20);
    expect(mixed.distanceKm).toBeCloseTo(clean.distanceKm, 6);
    expect(mixed.denseKm).toBeCloseTo(clean.denseKm, 6);
    expect(mixed.harshBraking).toBe(clean.harshBraking);
    expect(mixed.harshAcceleration).toBe(clean.harshAcceleration);
    expect(mixed.harshCornering).toBe(clean.harshCornering);
    // the no-fix reports must not be counted as samples of the trip either
    expect(mixed.samples).toBe(clean.samples);
  });
});

describe("storing reports", () => {
  const record = (ts: Date, lat: number, lng: number, eventId = 0) => ({
    timestamp: ts,
    priority: 0,
    gps: { latitude: lat, longitude: lng, altitude: 0, angle: 0, satellites: lat === 0 ? 0 : 8, speed: 0 },
    io: { eventId, elements: new Map<number, number>([[66, 12462]]) },
  });

  it("stores every report, but only hands the ones with a fix to toll detection", async () => {
    await position.storeAvlRecords(DEVICE, [record(at(0), 0, 0), record(at(1), 45.1, 9.1), record(at(2), 0, 0)]);
    expect(await db.select().from(positions)).toHaveLength(3);
    expect(harness.tollCalls).toHaveLength(1);
    const passed = harness.tollCalls[0]![1] as Array<{ lat: number }>;
    expect(passed.map((r) => r.lat)).toEqual([45.1]);
  });

  it("still records an alarm event that arrives with no fix", async () => {
    await position.storeAvlRecords(DEVICE, [record(at(0), 0, 0, 252)]);
    const events = await db.select().from(deviceEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("unplug_change");
  });

  it("records a silent stretch (tracker off or unplugged) when it reports again, but not a normal pause", async () => {
    await position.storeAvlRecords(DEVICE, [record(at(0), 45.1, 9.1)]);
    await position.storeAvlRecords(DEVICE, [record(at(30), 45.1, 9.1)]); // half an hour: parked
    expect((await db.select().from(deviceEvents)).filter((e) => e.type === "tracking_gap")).toHaveLength(0);

    await position.storeAvlRecords(DEVICE, [record(at(30 + 12 * 60), 0, 0), record(at(30 + 12 * 60 + 1), 45.2, 9.2)]);
    const gaps = (await db.select().from(deviceEvents)).filter((e) => e.type === "tracking_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ ts: at(30 + 12 * 60), payload: { minutes: 12 * 60 } });
  });

  it("does not flag the first report of a device, nor a backlog that fills the stretch in", async () => {
    await position.storeAvlRecords(DEVICE, [record(at(500), 45.1, 9.1)]);
    expect(await db.select().from(deviceEvents)).toHaveLength(0);
    // an old backlog sent late: its records sit before the newest one and are spaced normally
    await position.storeAvlRecords(DEVICE, [record(at(100), 45.1, 9.1), record(at(110), 45.1, 9.1)]);
    expect((await db.select().from(deviceEvents)).filter((e) => e.type === "tracking_gap")).toHaveLength(0);
  });
});
