import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The real queries of the maintenance service against an in-memory Postgres, with the real migration SQL for the
 * tables. Only the tracker's latest position is faked. A car whose odometer is read through OBD (ID 389) is measured
 * against it; any other is counted from the GPS days in vehicle_daily_km.
 */

const harness = vi.hoisted(() => ({ ioData: {} as Record<string, number | string>, hasPosition: true }));

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

vi.mock("../../src/services/position.service.js", () => ({
  getLatestReading: async () => (harness.hasPosition ? { ioData: harness.ioData } : undefined),
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const service = await import("../../src/services/maintenance.service.js");
const { db } = clientModule;
const { maintenancePlans, maintenanceRecords, vehicles, vehicleDailyKm } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const V_DHL = "00000000-0000-0000-0000-0000000000a1";
const V_UNI = "00000000-0000-0000-0000-0000000000a2";
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
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const file of ["0017_maintenance.sql", "0029_vehicle_daily_km.sql"]) {
    const migration = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      // the vehicles column is part of the stub table above
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
    { id: V_DHL, orgId: ORG, name: "VAN-1", plate: "AB123CD", fleetGroup: "DHL", deviceId: DEVICE },
    { id: V_UNI, orgId: ORG, name: "VAN-2", fleetGroup: "UNIVEX", deviceId: null },
    { id: V_OTHER, orgId: OTHER_ORG, name: "OTHER", fleetGroup: null, deviceId: null },
  ]);
  harness.hasPosition = true;
  harness.ioData = { "389": 8000 }; // the car's own odometer, read through OBD: 8 000 km
});

const OIL = { name: "Cambio de aceite", intervalKm: 15000, intervalMonths: 12 };
const day = (vehicleId: string, date: string, km: number) => db.insert(vehicleDailyKm).values({ vehicleId, day: date, km });

describe("createPlan", () => {
  it("starts counting from today at the vehicle's current odometer", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    expect(plan).toMatchObject({ lastDoneKm: 8000, intervalKm: 15000, status: { state: "ok", dueKm: 23000, kmRemaining: 15000 } });
    expect(plan.lastDoneAt).toEqual(NOW);
  });

  it("accepts an explicit baseline from the past", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...OIL, lastDoneAt: new Date("2025-09-01T00:00:00Z"), lastDoneKm: 1000 }, NOW);
    // 8 000 km of 15 000 used, but 13 months have passed against a 12-month limit
    expect(plan.status).toMatchObject({ state: "overdue", dueKm: 16000, kmRemaining: 8000 });
    expect(plan.status.daysRemaining).toBeLessThan(0);
  });

  it("needs an interval in km, months or both", async () => {
    await expect(service.createPlan(ORG, null, V_DHL, { name: "Nada" }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(service.createPlan(ORG, null, V_DHL, { name: "Nada", intervalKm: null, intervalMonths: null }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(service.createPlan(ORG, null, V_DHL, { name: "Solo fecha", intervalMonths: 24 }, NOW)).resolves.toBeDefined();
  });

  it("counts from the GPS when the vehicle's odometer is not read: nothing driven yet, the whole interval left", async () => {
    const plan = await service.createPlan(ORG, null, V_UNI, OIL, NOW);
    expect(plan).toMatchObject({ kmSource: "gps", lastDoneKm: null, kmSince: 0, dashboardKm: null });
    expect(plan.status).toMatchObject({ state: "ok", kmRemaining: 15000 });
  });

  it("does not exist for a vehicle of another organization or outside the área", async () => {
    await expect(service.createPlan(ORG, null, V_OTHER, OIL, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.createPlan(ORG, "UNIVEX", V_DHL, OIL, NOW)).rejects.toMatchObject({ status: 404 });
  });
});

describe("listMaintenance", () => {
  it("lists the visible vehicles with their plans and odometer, sorted by name", async () => {
    await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    await service.createPlan(ORG, null, V_DHL, { name: "Frenos", intervalKm: 30000 }, NOW);
    const list = await service.listMaintenance(ORG, null, NOW);
    expect(list.map((v) => v.name)).toEqual(["VAN-1", "VAN-2"]);
    expect(list[0]).toMatchObject({ kmSource: "obd", trackerKm: 8000, offsetKm: 0, odometerKm: 8000 });
    expect(list[0]!.plans.map((p) => p.name)).toEqual(["Cambio de aceite", "Frenos"]);
    expect(list[1]).toMatchObject({ kmSource: "gps", trackerKm: null, odometerKm: null, gpsKmTotal: 0, gpsCoverageFrom: null, plans: [] });
  });

  it("only shows the caller's área, and never another organization's vehicles", async () => {
    const list = await service.listMaintenance(ORG, "DHL", NOW);
    expect(list.map((v) => v.name)).toEqual(["VAN-1"]);
    expect((await service.listMaintenance(OTHER_ORG, null, NOW)).map((v) => v.name)).toEqual(["OTHER"]);
  });

  it("flags a plan as overdue when the tracker has run past the due km", async () => {
    await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    harness.ioData = { "389": 24000 };
    const [van1] = await service.listMaintenance(ORG, null, NOW);
    expect(van1!.plans[0]!.status).toMatchObject({ state: "overdue", kmRemaining: -1000 });
  });
});

describe("registerService", () => {
  it("moves the baseline to now at the current odometer and keeps the history", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, new Date("2026-01-01T00:00:00Z"));
    harness.ioData = { "389": 23000 };
    const after = await service.registerService(ORG, null, plan.id, { notes: "Olio 5W30" }, NOW);
    expect(after).toMatchObject({ lastDoneKm: 23000, status: { state: "ok", dueKm: 38000 } });
    expect(after.lastDoneAt).toEqual(NOW);

    const records = await service.listRecords(ORG, null, plan.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ odometerKm: 23000, notes: "Olio 5W30" });
  });

  it("logging an older service does not push the next due point backwards", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    const after = await service.registerService(ORG, null, plan.id, { doneAt: new Date("2026-03-01T00:00:00Z"), odometerKm: 3000 }, NOW);
    expect(after.lastDoneKm).toBe(8000);
    expect(after.lastDoneAt).toEqual(NOW);
    expect(await service.listRecords(ORG, null, plan.id)).toHaveLength(1);
  });

  it("a past service with no km given leaves the km baseline alone", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...OIL, lastDoneAt: new Date("2025-01-01T00:00:00Z"), lastDoneKm: 100 }, NOW);
    const after = await service.registerService(ORG, null, plan.id, { doneAt: new Date("2026-06-01T00:00:00Z") }, NOW);
    expect(after.lastDoneKm).toBe(100);
    expect(after.lastDoneAt).toEqual(new Date("2026-06-01T00:00:00Z"));
  });

  it("refuses a date in the future", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    await expect(service.registerService(ORG, null, plan.id, { doneAt: new Date("2026-12-01T00:00:00Z") }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("cannot touch a plan of another organization or área", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    await expect(service.registerService(OTHER_ORG, null, plan.id, {}, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.registerService(ORG, "UNIVEX", plan.id, {}, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.listRecords(ORG, "UNIVEX", plan.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("updatePlan and deletePlan", () => {
  it("edits only the named fields and still needs an interval", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    const renamed = await service.updatePlan(ORG, null, plan.id, { name: "Aceite y filtros" }, NOW);
    expect(renamed).toMatchObject({ name: "Aceite y filtros", intervalKm: 15000, intervalMonths: 12 });

    await expect(service.updatePlan(ORG, null, plan.id, { intervalKm: null }, NOW)).resolves.toMatchObject({ intervalKm: null, intervalMonths: 12 });
    await expect(service.updatePlan(ORG, null, plan.id, { intervalMonths: null }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("deleting a plan removes its history too", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW);
    await service.registerService(ORG, null, plan.id, {}, NOW);
    await service.deletePlan(ORG, null, plan.id);
    expect(await db.select().from(maintenanceRecords)).toHaveLength(0);
    await expect(service.deletePlan(ORG, null, plan.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("calibrateOdometer", () => {
  it("sets the offset so the tracker matches the dashboard, and shifts baselines with it", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, OIL, NOW); // baseline 8 000 (tracker scale)
    await service.registerService(ORG, null, plan.id, { odometerKm: 7500, doneAt: new Date("2026-10-01T00:00:00Z") }, NOW);

    const result = await service.calibrateOdometer(ORG, null, V_DHL, 85_000);
    expect(result).toEqual({ source: "obd", trackerKm: 8000, offsetKm: 77000, odometerKm: 85000 });

    const [van1] = await service.listMaintenance(ORG, null, NOW);
    expect(van1).toMatchObject({ trackerKm: 8000, offsetKm: 77000, odometerKm: 85000 });
    // "done at 8 000 on the tracker" is "done at 85 000 on the dashboard": the plan is still fresh.
    expect(van1!.plans[0]).toMatchObject({ lastDoneKm: 85000, status: { state: "ok", dueKm: 100000, kmRemaining: 15000 } });
    expect((await service.listRecords(ORG, null, plan.id))[0]!.odometerKm).toBe(84500);

    // calibrating again moves by the difference only
    await service.calibrateOdometer(ORG, null, V_DHL, 86_000);
    const [again] = await service.listMaintenance(ORG, null, NOW);
    expect(again!.plans[0]!.lastDoneKm).toBe(86000);
    expect((await db.select().from(vehicles).where(eq(vehicles.id, V_DHL)))[0]!.odometerOffsetKm).toBe(78000);
  });

  it("on a vehicle counted by GPS, adjusts each plan so the dashboard figure is what it reads now", async () => {
    harness.ioData = {};
    await day(V_DHL, "2026-10-10", 100);
    await service.createPlan(ORG, null, V_DHL, { name: "Tagliando", intervalKm: 20000, lastDoneAt: new Date("2026-10-01T10:00:00Z"), lastDoneKm: 130000 }, NOW);
    const result = await service.calibrateOdometer(ORG, null, V_DHL, 130_400);
    expect(result).toMatchObject({ source: "gps", trackerKm: null, odometerKm: 130400 });
    const [van1] = await service.listMaintenance(ORG, null, NOW);
    expect(van1!.plans[0]).toMatchObject({ kmSince: 400, dashboardKm: 130400 });
    expect(van1!.plans[0]!.status.kmRemaining).toBe(19600);
  });

  it("refuses a dashboard reading below the km the plans were last done at", async () => {
    harness.ioData = {};
    await service.createPlan(ORG, null, V_DHL, { name: "Tagliando", intervalKm: 20000, lastDoneAt: new Date("2026-10-01T10:00:00Z"), lastDoneKm: 130000 }, NOW);
    await expect(service.calibrateOdometer(ORG, null, V_DHL, 120_000)).rejects.toMatchObject({ status: 400 });
  });

  it("is not reachable for another organization or área", async () => {
    await expect(service.calibrateOdometer(OTHER_ORG, null, V_DHL, 1000)).rejects.toMatchObject({ status: 404 });
    await expect(service.calibrateOdometer(ORG, "UNIVEX", V_DHL, 1000)).rejects.toMatchObject({ status: 404 });
  });
});

describe("plans counted by GPS", () => {
  const TAGLIANDO = { name: "Tagliando", intervalKm: 20000 };
  const DONE = { lastDoneAt: new Date("2026-10-01T15:00:00Z"), lastDoneKm: 130000 };

  beforeEach(async () => {
    harness.ioData = {}; // no OBD odometer: the GPS counts
    await day(V_DHL, "2026-09-25", 300); // before the service: not counted
    await day(V_DHL, "2026-10-01", 80); // the day of the service itself: not counted
    await day(V_DHL, "2026-10-02", 120.4);
    await day(V_DHL, "2026-10-03", 200.4);
  });

  it("counts the km driven from the day after the service, and follows the dashboard from the km it was done at", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    expect(plan).toMatchObject({ kmSource: "gps", kmSince: 321, dashboardKm: 130321, partialCoverage: false });
    expect(plan.status).toMatchObject({ state: "ok", dueKm: 150000, kmRemaining: 19679 });
  });

  it("turns orange with 8 000 km or fewer left and red below 4 000 (3 999 or less), on a 20 000 km service", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    const stateAfter = async (driven: number) => {
      await db.delete(vehicleDailyKm);
      await day(V_DHL, "2026-10-05", driven);
      return (await service.listMaintenance(ORG, null, NOW))[0]!.plans.find((p) => p.id === plan.id)!.status;
    };
    expect(await stateAfter(11_999)).toMatchObject({ state: "ok", kmRemaining: 8001 });
    expect(await stateAfter(12_000)).toMatchObject({ state: "soon", kmRemaining: 8000 });
    expect(await stateAfter(16_000)).toMatchObject({ state: "soon", kmRemaining: 4000 });
    expect(await stateAfter(16_001)).toMatchObject({ state: "due", kmRemaining: 3999 });
    expect(await stateAfter(20_000)).toMatchObject({ state: "due", kmRemaining: 0 });
    expect(await stateAfter(20_001)).toMatchObject({ state: "overdue", kmRemaining: -1 });
  });

  it("says when the service was before the GPS started counting, and a dashboard reading makes up the difference", async () => {
    const early = { ...TAGLIANDO, lastDoneAt: new Date("2026-08-01T10:00:00Z"), lastDoneKm: 120000 };
    const plan = await service.createPlan(ORG, null, V_DHL, early, NOW);
    expect(plan.partialCoverage).toBe(true); // the first day counted is 25/09

    const fixed = await service.updatePlan(ORG, null, plan.id, { dashboardKm: 126_000 }, NOW);
    expect(fixed).toMatchObject({ kmSince: 6000, dashboardKm: 126000, partialCoverage: false });
    expect(fixed.status.kmRemaining).toBe(14000);
  });

  it("registering a service restarts the count from that service", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    const after = await service.registerService(ORG, null, plan.id, { doneAt: new Date("2026-10-10T09:00:00Z"), odometerKm: 131_000 }, NOW);
    expect(after).toMatchObject({ lastDoneKm: 131000, kmSince: 0, dashboardKm: 131000 });
    expect(after.status).toMatchObject({ state: "ok", dueKm: 151000, kmRemaining: 20000 });
  });

  it("registering a service today with no km uses the dashboard figure it estimates", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    const after = await service.registerService(ORG, null, plan.id, {}, NOW);
    expect(after).toMatchObject({ lastDoneKm: 130321, kmSince: 0 });
  });

  it("changing the baseline of a plan starts its count over", async () => {
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    const moved = await service.updatePlan(ORG, null, plan.id, { lastDoneAt: new Date("2026-10-02T15:00:00Z"), lastDoneKm: 130100 }, NOW);
    expect(moved).toMatchObject({ kmSince: 200, dashboardKm: 130300 });
  });

  it("needs the km and date of the service to line up with the dashboard", async () => {
    await expect(service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, dashboardKm: 130_000 }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("the car's own odometer, when read, wins over the GPS count", async () => {
    harness.ioData = { "389": 134_000 };
    const plan = await service.createPlan(ORG, null, V_DHL, { ...TAGLIANDO, ...DONE }, NOW);
    expect(plan).toMatchObject({ kmSource: "obd", kmSince: 4000, dashboardKm: 134000 });
    expect(plan.status).toMatchObject({ state: "ok", kmRemaining: 16000 });
  });
});
