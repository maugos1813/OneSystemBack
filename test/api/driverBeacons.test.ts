import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Driver beacons end to end against an in-memory Postgres: what the trackers report, who is named, and who may see or manage it. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/services/userModules.service.js", () => ({
  getUserModules: async () => ["vehiculos", "historial", "conduccion"],
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const DEVICE = { dhl: id(12), piazza: id(11) };
const VEHICLE = { dhl: id(22), piazza: id(21) };

// An Eddystone beacon: flags 0x01 (RSSI), namespace + instance, RSSI byte.
const MARCO = "eddystone:00112233445566778899-abcde0810047";
const marcoPayload = (rssi: number) => "11" + "01" + "00112233445566778899" + "abcde0810047" + (rssi & 0xff).toString(16).padStart(2, "0");

// Twenty minutes of driving that ended about an hour ago.
const START = Date.now() - 80 * 60_000;
const RANGE = `from=${new Date(START - 3_600_000).toISOString()}&to=${new Date(START + 3 * 3_600_000).toISOString()}`;
let app: Awaited<ReturnType<typeof buildApp>>;

const as = (role: string, allowedArea: string | null, orgId = ORG) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: id(90), orgId, role, allowedArea } as never)}`,
});

beforeAll(async () => {
  const rows: string[] = [];
  // 20 minutes of driving, a report every 30 s, the beacon heard each time
  for (let i = 0; i < 40; i++) {
    const ts = new Date(START + i * 30_000).toISOString();
    rows.push(`('${DEVICE.dhl}', '${ts}', 45.1, 9.1, 60, '{"385":"${marcoPayload(-62)}"}')`);
    rows.push(`('${DEVICE.piazza}', '${ts}', 45.2, 9.2, 60, '{"66":12000}')`);
  }
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY, org_id uuid, imei varchar(20) NOT NULL UNIQUE, model varchar(50) NOT NULL DEFAULT 'FMB204',
      serial_number varchar(32), firmware varchar(32), status varchar(20) NOT NULL DEFAULT 'active', source varchar(20) NOT NULL DEFAULT 'teltonika',
      last_seen_at timestamptz, green_driving_since timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20), fleet_group varchar(50),
      device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE positions (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL,
      lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0,
      priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
    CREATE TABLE driver_beacons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, beacon_id varchar(100) NOT NULL,
      driver_name varchar(100) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, beacon_id));
    INSERT INTO devices (id, org_id, imei) VALUES ('${DEVICE.dhl}', '${ORG}', '350000000000012'), ('${DEVICE.piazza}', '${ORG}', '350000000000011');
    INSERT INTO vehicles (id, org_id, name, plate, fleet_group, device_id) VALUES
      ('${VEHICLE.dhl}', '${ORG}', 'DHL van', 'DH222BB', 'DHL', '${DEVICE.dhl}'),
      ('${VEHICLE.piazza}', '${ORG}', 'Piazza van', 'PZ111AA', 'PIAZZA', '${DEVICE.piazza}');
    INSERT INTO positions (device_id, ts, lat, lng, speed, io_data) VALUES ${rows.join(",")};
  `);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as never });

describe("driver beacons", () => {
  it("shows a new beacon among the detected ones, unassigned, so an admin can name its driver", async () => {
    const res = await call("GET", "/driver-beacons/detected?hours=72", as("owner", null));
    const found = (res.json() as Array<{ beaconId: string; driverName: string | null; vehicle: { id: string } }>).find((b) => b.beaconId === MARCO);
    expect(found).toMatchObject({ driverName: null, vehicle: { id: VEHICLE.dhl } });
  });

  it("names the driver of the vehicle once the beacon is assigned", async () => {
    expect((await call("POST", "/driver-beacons", as("owner", null), { beaconId: MARCO, driverName: "Marco Rossi" })).statusCode).toBe(201);
    expect((await call("POST", "/driver-beacons", as("owner", null), { beaconId: MARCO, driverName: "Otro" })).statusCode).toBe(409);

    const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("owner", null));
    expect(res.json()).toMatchObject({ confidence: "high", driver: { name: "Marco Rossi", beaconId: MARCO }, others: [] });

    const other = await call("GET", `/vehicles/${VEHICLE.piazza}/driver?${RANGE}`, as("owner", null));
    expect(other.json()).toMatchObject({ driver: null, confidence: null });
  });

  it("refuses a malformed beacon id", async () => {
    expect((await call("POST", "/driver-beacons", as("owner", null), { beaconId: "not a beacon", driverName: "X" })).statusCode).toBe(400);
  });

  it("is managed only by owner/admin of an organization-wide account", async () => {
    expect((await call("GET", "/driver-beacons", as("viewer", null))).statusCode).toBe(403);
    expect((await call("POST", "/driver-beacons", as("manager", null), { beaconId: MARCO, driverName: "X" })).statusCode).toBe(403);
    expect((await call("GET", "/driver-beacons", as("admin", "DHL"))).statusCode).toBe(403);
    expect((await call("GET", "/driver-beacons", {})).statusCode).toBe(401);
  });

  it("tells a client of another área nothing about a vehicle that is not theirs", async () => {
    expect((await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("viewer", "DHL"))).statusCode).toBe(200);
    const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("viewer", "PIAZZA"));
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("Marco");
  });

  it("never mixes organizations", async () => {
    const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("owner", null, OTHER_ORG));
    expect(res.statusCode).toBe(404);
    expect(((await call("GET", "/driver-beacons", as("owner", null, OTHER_ORG))).json() as unknown[]).length).toBe(0);
  });

  it("renames and removes a beacon", async () => {
    const [beacon] = (await call("GET", "/driver-beacons", as("owner", null))).json() as Array<{ id: string }>;
    expect((await call("PATCH", `/driver-beacons/${beacon!.id}`, as("owner", null), { driverName: "Marco R." })).json()).toMatchObject({ driverName: "Marco R." });
    expect((await call("DELETE", `/driver-beacons/${beacon!.id}`, as("owner", null))).statusCode).toBe(204);
    expect((await call("DELETE", `/driver-beacons/${beacon!.id}`, as("owner", null))).statusCode).toBe(404);
  });
});
