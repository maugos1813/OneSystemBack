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
      device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0, brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text, odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE positions (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL,
      lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0,
      priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
    CREATE TABLE driver_beacons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, beacon_id varchar(100) NOT NULL,
      driver_name varchar(100) NOT NULL, phone varchar(30), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, beacon_id));
    CREATE TABLE driver_people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, external_id varchar(64) NOT NULL, name varchar(150) NOT NULL,
      phone varchar(40), active boolean NOT NULL DEFAULT true, habitual_plate varchar(20), synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, external_id));
    CREATE TABLE driver_usages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, external_id varchar(64) NOT NULL, driver_external_id varchar(64) NOT NULL,
      plate varchar(20) NOT NULL, final_plate varchar(20), starts_at timestamptz NOT NULL, ends_at timestamptz, declared boolean NOT NULL DEFAULT false,
      status varchar(20) NOT NULL, synced_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, external_id));
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

  it("registers an EYE Beacon from the MAC on its label, in any common spelling", async () => {
    const created = await call("POST", "/driver-beacons", as("owner", null), { mac: "7C:D9:F4:0B:39:E3", driverName: "Luca Bianchi" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ beaconId: "eddystone:00000000000000000000-7cd9f40b39e3", driverName: "Luca Bianchi" });
    expect((await call("POST", "/driver-beacons", as("owner", null), { mac: "7cd9f40b39e3", driverName: "Otro" })).statusCode).toBe(409);
    expect((await call("POST", "/driver-beacons", as("owner", null), { mac: "7CD9-F40B-39E4", driverName: "Anna" })).statusCode).toBe(201);
  });

  it("refuses a bad MAC, and a request with both or neither identifier", async () => {
    expect((await call("POST", "/driver-beacons", as("owner", null), { mac: "7CD9F40B39", driverName: "X" })).statusCode).toBe(400);
    expect((await call("POST", "/driver-beacons", as("owner", null), { mac: "7CD9F40B39E5", beaconId: MARCO, driverName: "X" })).statusCode).toBe(400);
    expect((await call("POST", "/driver-beacons", as("owner", null), { driverName: "X" })).statusCode).toBe(400);
  });

  it("lists, per vehicle with a Teltonika tracker, the drivers heard in it and the unnamed beacons apart", async () => {
    await call("POST", "/driver-beacons", as("owner", null), { beaconId: MARCO, driverName: "Marco Rossi" });
    const res = await call("GET", "/driver-beacons/by-vehicle?hours=72", as("owner", null));
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{
      vehicle: { id: string; name: string; model: string };
      lastReport: string | null;
      beacons: Array<{ beaconId: string; driverName: string | null; sightings: number; movingSightings: number; avgRssi: number | null }>;
    }>;
    expect(list.map((v) => v.vehicle.name)).toEqual(["DHL van", "Piazza van"]);
    const dhl = list[0]!;
    expect(dhl.beacons).toHaveLength(1);
    expect(dhl.beacons[0]).toMatchObject({ beaconId: MARCO, driverName: "Marco Rossi", sightings: 40, movingSightings: 40, avgRssi: -62 });
    expect(dhl.lastReport).not.toBeNull();
    // a vehicle whose tracker heard nothing is still listed, with nothing in it
    expect(list[1]).toMatchObject({ beacons: [], lastReport: null });
  });

  it("only owner/admin of an organization-wide account may read the per-vehicle list", async () => {
    expect((await call("GET", "/driver-beacons/by-vehicle", as("viewer", null))).statusCode).toBe(403);
    expect((await call("GET", "/driver-beacons/by-vehicle", as("admin", "DHL"))).statusCode).toBe(403);
    expect((await call("GET", "/driver-beacons/by-vehicle?hours=9999", as("owner", null))).statusCode).toBe(400);
    expect((await call("GET", "/driver-beacons/by-vehicle", {})).statusCode).toBe(401);
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

  it("keeps the driver's phone so the vehicle's panel can call them, and cleans it up", async () => {
    const [marco] = ((await call("GET", "/driver-beacons", as("owner", null))).json() as Array<{ id: string; beaconId: string }>).filter((b) => b.beaconId === MARCO);
    const patch = (phone: string | null) => call("PATCH", `/driver-beacons/${marco!.id}`, as("owner", null), { phone });

    expect((await patch("+39 333 123-4567")).json()).toMatchObject({ phone: "+393331234567", driverName: "Marco Rossi" });
    const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("owner", null));
    expect(res.json()).toMatchObject({ driver: { name: "Marco Rossi", phone: "+393331234567" } });

    expect((await patch("abc")).statusCode).toBe(400);
    expect((await patch("")).json()).toMatchObject({ phone: null });
    expect((await call("PATCH", `/driver-beacons/${marco!.id}`, as("owner", null), {})).statusCode).toBe(400);

    const created = await call("POST", "/driver-beacons", as("owner", null), { mac: "AABBCCDDEEFF", driverName: "Con teléfono", phone: "0039 06 1234567" });
    expect(created.json()).toMatchObject({ phone: "0039061234567" });
  });

  describe("with Gamonal Driver saying who has the vehicle", () => {
    const at = (minutesFromStart: number) => new Date(START + minutesFromStart * 60_000).toISOString();
    const seed = (name: string, phone: string | null, usage: { id: string; plate: string; from: string; to: string | null; final?: string }) =>
      pg.exec(`
        INSERT INTO driver_people (org_id, external_id, name, phone) VALUES ('${ORG}', 'p-${usage.id}', '${name}', ${phone ? `'${phone}'` : "NULL"});
        INSERT INTO driver_usages (org_id, external_id, driver_external_id, plate, final_plate, starts_at, ends_at, declared, status)
          VALUES ('${ORG}', '${usage.id}', 'p-${usage.id}', '${usage.plate}', ${usage.final ? `'${usage.final}'` : "NULL"}, '${usage.from}', ${usage.to ? `'${usage.to}'` : "NULL"}, true, 'CONSEGNATO');`);

    it("names that driver, with the phone, even though no beacon was heard in that vehicle", async () => {
      await seed("Giulia Verdi", "+393331112222", { id: "s-piazza", plate: "PZ111AA", from: at(-60), to: at(120) });
      const res = await call("GET", `/vehicles/${VEHICLE.piazza}/driver?${RANGE}`, as("owner", null));
      expect(res.json()).toMatchObject({
        source: "driver",
        confidence: "high",
        driver: { name: "Giulia Verdi", phone: "+393331112222", beaconId: null },
        beaconDriver: null,
      });
    });

    it("prefers the Driver over the beacon and shows who the beacon heard when it is somebody else", async () => {
      await seed("Luca Neri", null, { id: "s-dhl", plate: "DH222BB", from: at(-60), to: at(120) });
      const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?${RANGE}`, as("owner", null));
      expect(res.json()).toMatchObject({ source: "driver", driver: { name: "Luca Neri" }, beaconDriver: { name: "Marco Rossi", beaconId: MARCO } });
    });

    it("does not call it a disagreement when the beacon driver is the same person written differently", async () => {
      await seed("Rossi Marco", "+390611111", { id: "s-dhl-2", plate: "DH222BB", from: at(60), to: at(120) });
      const res = await call("GET", `/vehicles/${VEHICLE.dhl}/driver?from=${at(70)}&to=${at(100)}`, as("owner", null));
      expect(res.json()).toMatchObject({ source: "driver", driver: { name: "Rossi Marco" } });
    });

    it("lists every driver the vehicle had in the period, and flags a van swapped halfway", async () => {
      await seed("Anna Blu", "+390622222", { id: "s-swap", plate: "AB000CD", final: "PZ111AA", from: at(130), to: at(200) });
      const res = await call("GET", `/vehicles/${VEHICLE.piazza}/usage?from=${at(-120)}&to=${at(300)}`, as("owner", null));
      const names = (res.json() as { usages: Array<{ driver: { name: string }; switched: boolean }> }).usages.map((u) => [u.driver.name, u.switched]);
      expect(names).toEqual([["Giulia Verdi", false], ["Anna Blu", true]]);
    });

    it("answers only for vehicles of the caller's área and the same organization", async () => {
      expect((await call("GET", `/vehicles/${VEHICLE.dhl}/usage?${RANGE}`, as("owner", null, OTHER_ORG))).statusCode).toBe(404);
      expect((await call("GET", `/vehicles/${VEHICLE.piazza}/usage?${RANGE}`, as("client", "DHL"))).statusCode).toBe(404);
      expect((await call("GET", `/vehicles/${VEHICLE.dhl}/usage?from=${at(10)}&to=${at(0)}`, as("owner", null))).statusCode).toBe(400);
    });
  });

  it("counts the readings taken with the engine on, even when the vehicle is not moving", async () => {
    // The tracker sends beacon scans as reports of their own, with no ignition: it is the ordinary report before that says it.
    const T = Date.now() - 30 * 60_000;
    const at = (min: number) => new Date(T + min * 60_000).toISOString();
    const scan = (rssi: number) => JSON.stringify({ "385": "11" + "01" + "00112233445566778899" + "ffeeddccbbaa" + (rssi & 0xff).toString(16).padStart(2, "0") });
    await pg.exec(`INSERT INTO positions (device_id, ts, lat, lng, speed, io_data) VALUES
      ('${DEVICE.piazza}', '${at(0)}', 45.2, 9.2, 0, '{"239":1}'),
      ('${DEVICE.piazza}', '${at(1)}', 45.2, 9.2, 0, '${scan(-60)}'),
      ('${DEVICE.piazza}', '${at(2)}', 45.2, 9.2, 0, '${scan(-60)}'),
      ('${DEVICE.piazza}', '${at(10)}', 45.2, 9.2, 0, '{"239":0}'),
      ('${DEVICE.piazza}', '${at(11)}', 45.2, 9.2, 0, '${scan(-60)}'),
      ('${DEVICE.piazza}', '${at(12)}', 45.2, 9.2, 0, '${scan(-60)}')`);

    const list = (await call("GET", "/driver-beacons/by-vehicle?hours=24", as("owner", null))).json() as Array<{
      vehicle: { id: string };
      beacons: Array<{ beaconId: string; sightings: number; movingSightings: number; ignitionSightings: number }>;
    }>;
    const beacon = list.find((v) => v.vehicle.id === VEHICLE.piazza)!.beacons.find((b) => b.beaconId === "eddystone:00112233445566778899-ffeeddccbbaa");
    expect(beacon).toMatchObject({ sightings: 4, movingSightings: 0, ignitionSightings: 2 });

    // A vehicle that moves counts as on even with no ignition report around.
    const dhl = list.find((v) => v.vehicle.id === VEHICLE.dhl)!.beacons.find((b) => b.beaconId === MARCO)!;
    expect(dhl.ignitionSightings).toBe(dhl.movingSightings);
    expect(dhl.movingSightings).toBeGreaterThan(0);
  });

  it("renames and removes a beacon", async () => {
    const [beacon] = (await call("GET", "/driver-beacons", as("owner", null))).json() as Array<{ id: string }>;
    expect((await call("PATCH", `/driver-beacons/${beacon!.id}`, as("owner", null), { driverName: "Marco R." })).json()).toMatchObject({ driverName: "Marco R." });
    expect((await call("DELETE", `/driver-beacons/${beacon!.id}`, as("owner", null))).statusCode).toBe(204);
    expect((await call("DELETE", `/driver-beacons/${beacon!.id}`, as("owner", null))).statusCode).toBe(404);
  });
});
