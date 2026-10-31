import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tagliando: due 20 000 km after the last one, measured against the vehicle's own current km. Real queries against an
 * in-memory Postgres; only the tracker's latest position is faked.
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
const tagliando = await import("../../src/services/tagliando.service.js");
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
      km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz, odometer_base_day_km double precision,
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

const typeKm = (vehicleId: string, km: number, daysAgo = 1) =>
  db.update(vehicles).set({ odometerBaseKm: km, odometerBaseAt: new Date(NOW.getTime() - daysAgo * 86_400_000) }).where(eq(vehicles.id, vehicleId));

describe("getTagliando", () => {
  it("has nothing to count from until a tagliando is entered", async () => {
    await typeKm(V_GPS, 80000);
    const view = await tagliando.getTagliando(ORG, null, V_GPS, NOW);
    expect(view).toMatchObject({ intervalKm: 20000, lastKm: null, currentKm: 80000, dueKm: null, kmRemaining: null, status: { state: "unknown" }, history: [] });
  });
});

describe("registerTagliando", () => {
  it("what is left is exactly the last tagliando's km plus 20 000, minus the km now", async () => {
    await typeKm(V_GPS, 78500);
    const view = await tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000 }, NOW);
    expect(view).toMatchObject({ lastKm: 60000, currentKm: 78500, dueKm: 80000, kmRemaining: 1500, status: { state: "due" } });
  });

  it("the km now keep themselves: the GPS adds what is driven, and the next one is only the same subtraction", async () => {
    await typeKm(V_GPS, 70000, 5);
    await tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000 }, NOW);
    await clientModule.__pg.exec(`INSERT INTO vehicle_daily_km (vehicle_id, day, km) VALUES ('${V_GPS}', '2026-10-15', 400)`);
    const view = await tagliando.getTagliando(ORG, null, V_GPS, NOW);
    expect(view).toMatchObject({ currentKm: 70400, dueKm: 80000, kmRemaining: 9600, status: { state: "ok" } });
  });

  it("a car that reads its own odometer needs nobody to type the km now", async () => {
    const view = await tagliando.registerTagliando(ORG, null, V_OBD, { km: 3000 }, NOW);
    expect(view).toMatchObject({ currentKm: 8000, source: "obd", dueKm: 23000, kmRemaining: 15000, status: { state: "ok" } });
  });

  it("is overdue once the km now pass the due point", async () => {
    await typeKm(V_GPS, 85000);
    expect(await tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000 }, NOW)).toMatchObject({ kmRemaining: -5000, status: { state: "overdue" } });
  });

  it("refuses a tagliando at more km than the vehicle has now (one of the two numbers is a typo)", async () => {
    await typeKm(V_GPS, 80000);
    await expect(tagliando.registerTagliando(ORG, null, V_GPS, { km: 90000 }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000, doneAt: new Date("2026-12-01T00:00:00Z") }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("a new tagliando moves the count to it and keeps the old one in the history; fixing rewrites only the last", async () => {
    await typeKm(V_GPS, 85000);
    await tagliando.registerTagliando(ORG, null, V_GPS, { km: 40000, doneAt: new Date("2026-03-01T10:00:00Z") }, NOW);
    const second = await tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000, doneAt: new Date("2026-09-01T10:00:00Z") }, NOW);
    expect(second).toMatchObject({ lastKm: 60000, dueKm: 80000, kmRemaining: -5000 });
    expect(second.history.map((h) => h.km)).toEqual([60000, 40000]);

    const fixed = await tagliando.registerTagliando(ORG, null, V_GPS, { km: 66000, mode: "fix" }, NOW);
    expect(fixed).toMatchObject({ lastKm: 66000, dueKm: 86000, kmRemaining: 1000 });
    expect(fixed.history.map((h) => h.km)).toEqual([66000, 40000]);
  });

  it("an older tagliando entered late does not push the next due point back", async () => {
    await typeKm(V_GPS, 85000);
    await tagliando.registerTagliando(ORG, null, V_GPS, { km: 60000, doneAt: new Date("2026-09-01T10:00:00Z") }, NOW);
    const view = await tagliando.registerTagliando(ORG, null, V_GPS, { km: 40000, doneAt: new Date("2026-03-01T10:00:00Z") }, NOW);
    expect(view).toMatchObject({ lastKm: 60000, dueKm: 80000 });
    expect(view.history).toHaveLength(2);
  });

  it("adopts the vehicle's existing plan called Tagliando and makes it a pure 20 000 km one", async () => {
    await typeKm(V_GPS, 70000);
    await db.insert(maintenancePlans).values({ orgId: ORG, vehicleId: V_GPS, name: "tagliando", intervalKm: 15000, intervalMonths: 12, lastDoneKm: 50000, lastDoneAt: new Date("2026-01-01T00:00:00Z") });
    expect((await tagliando.getTagliando(ORG, null, V_GPS, NOW)).dueKm).toBe(70000);
    await tagliando.registerTagliando(ORG, null, V_GPS, { km: 65000 }, NOW);
    const plans = await db.select().from(maintenancePlans).where(eq(maintenancePlans.vehicleId, V_GPS));
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ intervalKm: 20000, intervalMonths: null, lastDoneKm: 65000 });
  });

  it("does not exist for a vehicle of another organization or outside the área", async () => {
    await expect(tagliando.registerTagliando(ORG, null, V_OTHER, { km: 1 }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(tagliando.getTagliando(ORG, "UNIVEX", V_OBD, NOW)).rejects.toMatchObject({ status: 404 });
  });
});
