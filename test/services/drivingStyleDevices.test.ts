import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A vehicle that changed device keeps its driving numbers: the harsh events, the kilometres and the speeding found by each device it
 * carried count for the vehicle while it was on it, and what the same device recorded on another vehicle does not.
 */
const harness = vi.hoisted(() => ({ pg: null as unknown as { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> } }));

vi.mock("../../src/db/client.js", () => ({
  db: {
    execute: async (query: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      return { rows: (await harness.pg.query(sql, params)).rows };
    },
  },
  pool: {},
}));

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const VEHICLE = { id: "00000000-0000-4000-8000-0000000000e1", name: "VAN", plate: "AB123CD", fleetGroup: null, deviceId: B };
const SWAP = new Date("2026-10-09T10:00:00Z");

vi.mock("../../src/services/vehicle.service.js", () => ({ listVehiclesForOrg: async () => [VEHICLE] }));
// The van carried A until 10:00, and carries B since then.
vi.mock("../../src/services/vehicleAssignment.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicleAssignment.service.js")>()),
  getAssignmentWindows: async () => new Map([[VEHICLE.id, [{ deviceId: A, from: new Date(0), to: SWAP }, { deviceId: B, from: SWAP, to: null }]]]),
}));

const { getDrivingStyle, getVehicleIncidents } = await import("../../src/services/drivingStyle.service.js");

const day = (hhmmss: string) => new Date(`2026-10-09T${hhmmss}Z`);
const M_PER_DEG = 111_320;

/** One report every 4 s driving north at `speed(t)`; `lat0` places it. */
async function drive(device: string, from: string, to: string, speed: (t: number) => number, lat0: number) {
  let lat = lat0;
  for (let t = day(from).getTime(), i = 0; t <= day(to).getTime(); t += 4000, i++) {
    const v = speed(i * 4);
    await harness.pg.query("insert into positions (device_id, ts, lat, lng, speed, angle) values ($1, $2, $3, $4, $5, $6)", [device, new Date(t).toISOString(), lat, 9, v, 0]);
    lat += ((v / 3.6) * 4) / M_PER_DEG;
  }
}

const brakeEvery = (t: number) => (t % 120 < 4 ? 100 : t % 120 < 8 ? 40 : 80);

beforeAll(async () => {
  harness.pg = new PGlite() as unknown as typeof harness.pg;
  await harness.pg.query(
    "create table positions (device_id uuid not null, ts timestamptz not null, lat double precision not null, lng double precision not null, speed integer not null, angle integer not null)",
    [],
  );
  // Device A on the van 08:00-10:00 (hard braking every 2 minutes), device B on the van from 10:00 (steady, no events).
  await drive(A, "08:00:00", "09:59:56", brakeEvery, 45.0);
  await drive(B, "10:00:04", "12:00:00", () => 80, 45.3);
  // The same device A, once it is on another vehicle (after 10:00): harsh braking that must NOT count for this van.
  await drive(A, "10:00:04", "12:00:00", (t) => (t % 60 < 4 ? 110 : t % 60 < 8 ? 30 : 70), 46.0);
});

afterAll(async () => {
  await (harness.pg as unknown as PGlite).close();
});

const query = { orgId: "org-devices", days: 1, from: day("08:00:00"), to: day("12:00:00"), speedLimitKmh: 120 };

describe("the driving numbers of a vehicle that changed device", () => {
  it("counts what device A found while it was on the van and what device B found since, and nothing else", async () => {
    const [van] = (await getDrivingStyle({ ...query, orgId: "org-both" })).vehicles;
    // 08:00-10:00 at 80 km/h with a hard braking every 2 minutes (A), then 10:00-12:00 steady 80 (B): about 160 km in four hours.
    expect(van!.distanceKm).toBeGreaterThan(300);
    expect(van!.incidents.harshBraking ?? 0).toBeGreaterThan(40);
    // A's braking after 10:00 (on another vehicle) would add ~120 more: it must not be in these numbers.
    expect(van!.incidents.harshBraking ?? 0).toBeLessThan(70);
  });

  it("with only the part after the swap, sees nothing of device A", async () => {
    const [van] = (await getDrivingStyle({ ...query, orgId: "org-after", from: day("10:00:30") })).vehicles;
    expect(van!.incidents.harshBraking).toBe(0);
  });

  it("finds the incidents of a vehicle across its devices, within the windows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day("12:30:00"));
    const windows = [
      { deviceId: A, from: new Date(0), to: SWAP },
      { deviceId: B, from: SWAP, to: null },
    ];
    const incidents = await getVehicleIncidents(windows, 1, 120);
    vi.useRealTimers();
    const braking = incidents.filter((i) => i.type === "harshBraking");
    expect(braking.length).toBeGreaterThan(40);
    // None after the swap: the only braking after 10:00 was recorded by A on the other vehicle.
    expect(braking.every((i) => i.ts < SWAP)).toBe(true);
  });

  it("returns nothing for a vehicle with no windows", async () => {
    expect(await getVehicleIncidents([], 1, 120)).toEqual([]);
  });
});
