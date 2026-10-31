import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A vehicle's current km: typed by hand, read from the car's own odometer, or the km typed plus what the GPS counted
 * after that day. Real queries against an in-memory Postgres; only the tracker's latest position is faked.
 */

const harness = vi.hoisted(() => ({
  ioData: {} as Record<string, number | string>,
  hasPosition: true,
  /** The last report that carried the odometer, when the newest one did not. */
  earlierIoData: null as Record<string, number | string> | null,
}));

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

vi.mock("../../src/services/position.service.js", () => ({
  getLatestReading: async () => (harness.hasPosition ? { ioData: harness.ioData } : undefined),
  getLatestOdometerReading: async () => (harness.earlierIoData ? { ioData: harness.earlierIoData } : undefined),
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const profile = await import("../../src/services/vehicleProfile.service.js");
const { db } = clientModule;
const { maintenancePlans, maintenanceRecords, vehicles, vehicleDailyKm } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const V_OBD = "00000000-0000-0000-0000-0000000000a1";
const V_GPS = "00000000-0000-0000-0000-0000000000a2";
const V_OTHER = "00000000-0000-0000-0000-0000000000a3";
const NOW = new Date("2026-10-17T12:00:00Z");

beforeAll(async () => {
  const pg = clientModule.__pg;
  await pg.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE devices (id uuid PRIMARY KEY);
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20),
      fleet_group varchar(50), device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0,
      brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text,
      odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz,
      km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const file of ["0017_maintenance.sql", "0029_vehicle_daily_km.sql"]) {
    const migration = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.includes('ALTER TABLE "vehicles"')) continue;
      await pg.exec(statement);
    }
  }
});

afterAll(async () => {
  await clientModule.__pg.close();
});

beforeEach(async () => {
  await db.delete(vehicleDailyKm);
  await db.delete(maintenanceRecords);
  await db.delete(maintenancePlans);
  await db.delete(vehicles);
  await clientModule.__pg.exec(`INSERT INTO organizations VALUES ('${ORG}'), ('${OTHER_ORG}') ON CONFLICT DO NOTHING; INSERT INTO devices VALUES ('${DEVICE}') ON CONFLICT DO NOTHING;`);
  await db.insert(vehicles).values([
    { id: V_OBD, orgId: ORG, name: "VAN-1", plate: "AB123CD", fleetGroup: "DHL", deviceId: DEVICE },
    { id: V_GPS, orgId: ORG, name: "VAN-2", fleetGroup: "UNIVEX", deviceId: null },
    { id: V_OTHER, orgId: OTHER_ORG, name: "OTHER", fleetGroup: null, deviceId: null },
  ]);
  harness.hasPosition = true;
  harness.earlierIoData = null;
  harness.ioData = { "389": 8000 }; // the car's own odometer, read through OBD
});

const day = (vehicleId: string, date: string, km: number) => db.insert(vehicleDailyKm).values({ vehicleId, day: date, km });

describe("resolveOdometer", () => {
  const ctx = (over: Partial<{ obdKm: number | null; obdRaw: number | null }> = {}) => ({
    obdKm: null,
    obdRaw: null,
    daily: [
      { day: "2026-10-10", km: 100 },
      { day: "2026-10-11", km: 50 },
      { day: "2026-10-12", km: 30 },
    ],
    coverageFrom: "2026-10-10",
    ...over,
  });
  const vehicle = { odometerMode: "auto", odometerBaseKm: null, odometerBaseAt: null, odometerOffsetKm: 0, kmFactor: 1, kmFactorAt: null };

  it("is unknown until someone types the km (nothing to count from), though the GPS count is always shown", () => {
    expect(profile.resolveOdometer(vehicle, ctx())).toMatchObject({ mode: "auto", km: null, source: "none", gpsKmTotal: 180, gpsCoverageFrom: "2026-10-10" });
  });

  it("adds the GPS km driven after the day the km was typed (that day itself is already in the reading)", () => {
    const typed = { ...vehicle, odometerBaseKm: 50000, odometerBaseAt: new Date("2026-10-10T15:00:00Z") };
    expect(profile.resolveOdometer(typed, ctx())).toMatchObject({ km: 50080, source: "gps", gpsKmSinceBase: 80, baseKm: 50000 });
  });

  it("prefers the car's own odometer, already lined up with the dashboard", () => {
    const typed = { ...vehicle, odometerBaseKm: 50000, odometerBaseAt: new Date("2026-10-10T15:00:00Z") };
    expect(profile.resolveOdometer(typed, ctx({ obdKm: 91234, obdRaw: 8000 }))).toMatchObject({ km: 91234, source: "obd", trackerKm: 8000 });
  });

  it("manual stays exactly at what was typed, whatever the GPS counts", () => {
    const manual = { ...vehicle, odometerMode: "manual", odometerBaseKm: 50000, odometerBaseAt: new Date("2026-10-10T15:00:00Z") };
    expect(profile.resolveOdometer(manual, ctx())).toMatchObject({ mode: "manual", km: 50000, source: "manual", gpsKmTotal: 180 });
    expect(profile.resolveOdometer(manual, ctx({ obdKm: 91234, obdRaw: 8000 }))).toMatchObject({ km: 50000, source: "manual" });
    expect(profile.resolveOdometer({ ...manual, odometerBaseKm: null }, ctx())).toMatchObject({ km: null, source: "none" });
  });
});

describe("the check reminder", () => {
  const ctx = { obdKm: null, obdRaw: null, daily: [], coverageFrom: null };
  const typed = (daysAgo: number) => ({
    odometerMode: "auto",
    odometerBaseKm: 50000,
    odometerBaseAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    odometerOffsetKm: 0,
    kmFactor: 1,
    kmFactorAt: null,
  });

  it("asks for the dashboard km again after 30 days, for a vehicle counted by GPS", () => {
    expect(profile.resolveOdometer(typed(29), ctx, NOW)).toMatchObject({ source: "gps", daysSinceBase: 29, needsCheck: false });
    expect(profile.resolveOdometer(typed(30), ctx, NOW)).toMatchObject({ daysSinceBase: 30, needsCheck: true });
  });

  it("never nags a vehicle that reads its own odometer, one kept by hand, or one with no km typed", () => {
    expect(profile.resolveOdometer(typed(90), { ...ctx, obdKm: 91000, obdRaw: 8000 }, NOW).needsCheck).toBe(false);
    expect(profile.resolveOdometer({ ...typed(90), odometerMode: "manual" }, ctx, NOW).needsCheck).toBe(false);
    expect(profile.resolveOdometer({ ...typed(90), odometerBaseKm: null, odometerBaseAt: null }, ctx, NOW)).toMatchObject({ needsCheck: false, daysSinceBase: null });
  });
});

describe("learnKmFactor", () => {
  const base = { odometerBaseKm: 50000, odometerBaseAt: new Date("2026-10-01T10:00:00Z") };
  const rawDaily = [
    { day: "2026-10-01", km: 90 }, // the day of the reading is already in it
    { day: "2026-10-05", km: 200 },
    { day: "2026-10-09", km: 300 },
  ];
  const ctx = { obdKm: null, rawDaily, daily: rawDaily };

  it("is the real distance over the counted one since the last reading", () => {
    expect(profile.learnKmFactor(base, 50515, ctx)).toEqual({ ratio: 1.03, trusted: true });
  });

  it("learns nothing from a short stretch, a car whose odometer is read, or no earlier reading", () => {
    expect(profile.learnKmFactor(base, 50515, { ...ctx, rawDaily: [{ day: "2026-10-05", km: 120 }] })).toBeNull();
    expect(profile.learnKmFactor(base, 50515, { ...ctx, obdKm: 91000 })).toBeNull();
    expect(profile.learnKmFactor({ odometerBaseKm: null, odometerBaseAt: null }, 50515, ctx)).toBeNull();
    expect(profile.learnKmFactor(base, 49000, ctx)).toBeNull();
  });

  it("does not trust a difference too big to be the GPS's habit (a typo, or a long gap in the track)", () => {
    expect(profile.learnKmFactor(base, 52500, ctx)).toMatchObject({ trusted: false });
    expect(profile.learnKmFactor(base, 50300, ctx)).toMatchObject({ trusted: false });
  });
});

describe("the vehicle's correction", () => {
  it("is learned when the dashboard km are typed again, and then scales what the GPS counts", async () => {
    await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 50000 }, new Date("2026-10-01T10:00:00Z"));
    await day(V_GPS, "2026-10-05", 200);
    await day(V_GPS, "2026-10-09", 300);
    const view = await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 50515 }, new Date("2026-10-10T10:00:00Z"));
    expect(view).toMatchObject({ km: 50515, kmFactor: 1.03, factorResult: "updated" });
    await day(V_GPS, "2026-10-12", 100);
    // 100 km counted on the road since the reading: the correction makes it 103
    expect((await profile.getVehicleProfile(ORG, null, V_GPS)).odometer).toMatchObject({ km: 50618, gpsKmSinceBase: 103 });
  });

  it("is left as it was when the difference is too big, and the person is told", async () => {
    await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 50000 }, new Date("2026-10-01T10:00:00Z"));
    await day(V_GPS, "2026-10-05", 500);
    const view = await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 52000 }, new Date("2026-10-10T10:00:00Z"));
    expect(view).toMatchObject({ km: 52000, kmFactor: 1, factorResult: "outOfRange" });
  });

  it("is not learned from a manual save", async () => {
    await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 50000 }, new Date("2026-10-01T10:00:00Z"));
    await day(V_GPS, "2026-10-05", 500);
    const view = await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "manual", km: 50515 }, new Date("2026-10-10T10:00:00Z"));
    expect(view).toMatchObject({ kmFactor: 1, factorResult: null });
  });
});

describe("setVehicleOdometer", () => {
  it("automatic with a km: the count starts from it and the GPS adds what is driven afterwards", async () => {
    await day(V_GPS, "2026-10-16", 40);
    const view = await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 50000 }, NOW);
    expect(view).toMatchObject({ mode: "auto", km: 50000, source: "gps", baseKm: 50000, gpsKmSinceBase: 0 });
    await day(V_GPS, "2026-10-18", 25);
    expect((await profile.getVehicleProfile(ORG, null, V_GPS)).odometer).toMatchObject({ km: 50025, gpsKmSinceBase: 25 });
  });

  it("automatic on a car whose odometer is read: its correction lines the reading up with the dashboard", async () => {
    const view = await profile.setVehicleOdometer(ORG, null, V_OBD, { mode: "auto", km: 91000 }, NOW);
    expect(view).toMatchObject({ km: 91000, source: "obd", offsetKm: 83000, trackerKm: 8000 });
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, V_OBD));
    expect(row!.odometerOffsetKm).toBe(83000);
  });

  it("manual keeps the typed km and leaves the car's correction alone", async () => {
    const view = await profile.setVehicleOdometer(ORG, null, V_OBD, { mode: "manual", km: 123456 }, NOW);
    expect(view).toMatchObject({ mode: "manual", km: 123456, source: "manual", offsetKm: 0 });
  });

  it("switching back to manual without a new km keeps the last one; with none ever typed it asks for it", async () => {
    await expect(profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "manual" }, NOW)).rejects.toMatchObject({ status: 400 });
    await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 70000 }, NOW);
    expect(await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "manual" }, NOW)).toMatchObject({ mode: "manual", km: 70000 });
  });

  it("does not exist for a vehicle of another organization or outside the área", async () => {
    await expect(profile.setVehicleOdometer(ORG, null, V_OTHER, { mode: "auto", km: 1 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(profile.setVehicleOdometer(ORG, "UNIVEX", V_OBD, { mode: "auto", km: 1 }, NOW)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the car's own odometer when the newest report does not carry it", () => {
  it("is read from the last report that did (a beacon scan is the newest, the car's km are still its km)", async () => {
    harness.ioData = { "385": "beacon" }; // the newest report: only a beacon scan
    harness.earlierIoData = { "389": 23274 };
    expect((await profile.getVehicleProfile(ORG, null, V_OBD)).odometer).toMatchObject({ mode: "auto", km: 23274, source: "obd", trackerKm: 23274 });
    expect((await profile.listVehicleOdometers(ORG, null)).find((r) => r.vehicleId === V_OBD)).toMatchObject({ km: 23274, source: "obd" });
  });

  it("falls back to the GPS count only when no report in the lookback had it", async () => {
    harness.ioData = { "385": "beacon" };
    harness.earlierIoData = null;
    await profile.setVehicleOdometer(ORG, null, V_OBD, { mode: "auto", km: 50000 }, NOW);
    expect((await profile.getVehicleProfile(ORG, null, V_OBD)).odometer).toMatchObject({ source: "gps", km: 50000 });
  });
});

describe("listVehicleOdometers", () => {
  it("gives every visible vehicle's km", async () => {
    await profile.setVehicleOdometer(ORG, null, V_GPS, { mode: "auto", km: 42000 }, NOW);
    const rows = await profile.listVehicleOdometers(ORG, null);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.vehicleId === V_GPS)).toMatchObject({ km: 42000, source: "gps" });
    expect(rows.find((r) => r.vehicleId === V_OBD)).toMatchObject({ km: 8000, source: "obd" });
    expect(await profile.listVehicleOdometers(ORG, "UNIVEX")).toHaveLength(1);
  });
});
