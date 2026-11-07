import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A vehicle's history is what each device it carried recorded while it was on it. This runs the real trigger of migration 0040 and
 * the real history queries against an in-memory Postgres.
 */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const position = await import("../../src/services/position.service.js");
const { getVehicleDeviceWindows } = await import("../../src/services/vehicleAssignment.service.js");
const pg = clientModule.__pg;

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const V1 = "00000000-0000-4000-8000-0000000000e1";
const V2 = "00000000-0000-4000-8000-0000000000e2";
const iso = (day: number, hour = 12) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const d = (day: number, hour = 12) => new Date(iso(day, hour));

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY);
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid, device_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE vehicle_device_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      from_ts timestamptz NOT NULL DEFAULT now(), to_ts timestamptz
    );
    CREATE UNIQUE INDEX open_vehicle ON vehicle_device_assignments (vehicle_id) WHERE to_ts IS NULL;
    CREATE UNIQUE INDEX open_device ON vehicle_device_assignments (device_id) WHERE to_ts IS NULL;
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
  `);
  // The function and the trigger, exactly as the migration creates them.
  const statements = readFileSync(new URL("../../drizzle/0040_gifted_sinister_six.sql", import.meta.url), "utf8").split("--> statement-breakpoint");
  for (const statement of statements.filter((s) => /CREATE (FUNCTION|TRIGGER)/.test(s))) await pg.exec(statement);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("TRUNCATE positions, device_events, vehicle_device_assignments, vehicles, devices CASCADE");
  await pg.exec(`INSERT INTO devices VALUES ('${A}'), ('${B}')`);
});

const fix = (deviceId: string, ts: string) => pg.query(`INSERT INTO positions (device_id, ts, lat, lng, speed) VALUES ('${deviceId}', '${ts}', 45, 9, 30)`);
const windowsOf = async (vehicleId: string) =>
  (await pg.query<{ device_id: string; from_ts: Date; to_ts: Date | null }>(`SELECT device_id, from_ts, to_ts FROM vehicle_device_assignments WHERE vehicle_id = '${vehicleId}' ORDER BY from_ts`)).rows;

describe("the trigger that keeps which device a vehicle carried", () => {
  it("opens an assignment when a vehicle is created with a device, and none when it has none", async () => {
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('${V1}', '${A}'), ('${V2}', NULL)`);
    expect(await windowsOf(V1)).toHaveLength(1);
    expect((await windowsOf(V1))[0]).toMatchObject({ device_id: A, to_ts: null });
    expect(await windowsOf(V2)).toHaveLength(0);
  });

  it("closes the old assignment and opens the new one when the vehicle's device changes", async () => {
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('${V1}', '${A}')`);
    await pg.exec(`UPDATE vehicles SET device_id = '${B}' WHERE id = '${V1}'`);
    const rows = await windowsOf(V1);
    expect(rows.map((r) => r.device_id).sort()).toEqual([A, B].sort());
    expect(rows.find((r) => r.device_id === A)!.to_ts).not.toBeNull();
    expect(rows.find((r) => r.device_id === B)!.to_ts).toBeNull();
  });

  it("closes the assignment when the device is taken off, and does nothing for other changes", async () => {
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('${V1}', '${A}')`);
    await pg.exec(`UPDATE vehicles SET org_id = '${V2}' WHERE id = '${V1}'`);
    expect(await windowsOf(V1)).toHaveLength(1);
    await pg.exec(`UPDATE vehicles SET device_id = NULL WHERE id = '${V1}'`);
    const rows = await windowsOf(V1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_ts).not.toBeNull();
  });

  it("takes a device off the vehicle that had it when another vehicle gets it", async () => {
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('${V1}', '${A}'), ('${V2}', NULL)`);
    await pg.exec(`UPDATE vehicles SET device_id = '${A}' WHERE id = '${V2}'`);
    expect((await windowsOf(V1))[0]!.to_ts).not.toBeNull();
    expect((await windowsOf(V2))[0]!.to_ts).toBeNull();
  });
});

describe("a vehicle's history follows the vehicle, whatever device it carries", () => {
  // Builds: V1 carried A until a moment, then B. Then A moved to V2. Each device recorded all along.
  async function scenario() {
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('${V1}', '${A}'), ('${V2}', NULL)`);
    await pg.exec(`UPDATE vehicle_device_assignments SET from_ts = '${iso(1, 0)}' WHERE vehicle_id = '${V1}'`);
    // The swaps, at known moments (the trigger stamps "now", so the test moves them into the past).
    await pg.exec(`UPDATE vehicles SET device_id = '${B}' WHERE id = '${V1}'`);
    await pg.exec(`UPDATE vehicle_device_assignments SET to_ts = '${iso(10, 0)}' WHERE vehicle_id = '${V1}' AND device_id = '${A}'`);
    await pg.exec(`UPDATE vehicle_device_assignments SET from_ts = '${iso(10, 0)}' WHERE vehicle_id = '${V1}' AND device_id = '${B}'`);
    await pg.exec(`UPDATE vehicles SET device_id = '${A}' WHERE id = '${V2}'`);
    await pg.exec(`UPDATE vehicle_device_assignments SET from_ts = '${iso(20, 0)}' WHERE vehicle_id = '${V2}'`);
    for (const day of [5, 15, 25]) {
      await fix(A, iso(day));
      await fix(B, iso(day));
    }
  }

  it("shows a vehicle what each device recorded while it was on it, and nothing from before or after", async () => {
    await scenario();
    const windows = await getVehicleDeviceWindows(V1, B);
    const history = await position.getPositionHistory({ windows });
    // V1: A on the 5th (it carried A until the 10th), B on the 15th and the 25th (it carries B since the 10th).
    expect(history.map((p) => [p.deviceId, p.ts.toISOString()]).sort()).toEqual(
      [[A, iso(5)], [B, iso(15)], [B, iso(25)]].map(([x, y]) => [x, new Date(y!).toISOString()]).sort(),
    );
  });

  it("does not mix a device's recordings from another vehicle into this one's", async () => {
    await scenario();
    const v2 = await position.getPositionHistory({ windows: await getVehicleDeviceWindows(V2, A) });
    // V2 carries A only since the 20th: A's recording of the 25th, not of the 5th or the 15th (those were V1's).
    expect(v2.map((p) => p.ts.toISOString())).toEqual([new Date(iso(25)).toISOString()]);
  });

  it("respects the range asked for and thins across the devices", async () => {
    await scenario();
    const windows = await getVehicleDeviceWindows(V1, B);
    const some = await position.getPositionHistory({ windows, from: d(12), to: d(20) });
    expect(some.map((p) => [p.deviceId, p.ts.toISOString()])).toEqual([[B, new Date(iso(15)).toISOString()]]);
    const thinned = await position.getPositionHistory({ windows, maxPoints: 2 });
    expect(thinned.length).toBeGreaterThanOrEqual(1);
    expect(thinned.length).toBeLessThanOrEqual(2);
  });

  it("reads the events of a vehicle the same way", async () => {
    await scenario();
    await pg.exec(`INSERT INTO device_events (device_id, ts, type) VALUES ('${A}', '${iso(5)}', 'ignition_change'), ('${A}', '${iso(25)}', 'ignition_change'), ('${B}', '${iso(15)}', 'ignition_change')`);
    const events = await position.getDeviceEvents({ windows: await getVehicleDeviceWindows(V1, B) });
    expect(events.map((e) => [e.deviceId, e.ts.toISOString()]).sort()).toEqual(
      [[A, new Date(iso(5)).toISOString()], [B, new Date(iso(15)).toISOString()]].sort(),
    );
  });

  it("keeps the history of a vehicle that no longer carries any device", async () => {
    await scenario();
    await pg.exec(`UPDATE vehicles SET device_id = NULL WHERE id = '${V1}'`);
    const windows = await getVehicleDeviceWindows(V1, null);
    expect(windows).toHaveLength(2);
    expect((await position.getPositionHistory({ windows })).length).toBeGreaterThan(0);
  });

  it("falls back to the device it has now, with all of its history, when nothing was ever kept for the vehicle", async () => {
    expect(await getVehicleDeviceWindows(V1, A)).toEqual([{ deviceId: A, from: new Date(0), to: null }]);
    expect(await getVehicleDeviceWindows(V1, null)).toEqual([]);
  });
});
