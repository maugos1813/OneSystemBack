import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * What a client can see is limited by the área in their token (allowedArea): Piazza must never reach a DHL vehicle, its device,
 * its positions or events, nor anything of another organization. This runs the real routes and services against an in-memory
 * Postgres, so a route that forgets the área filter shows up here as a leak instead of in front of a client.
 */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/services/userModules.service.js", () => ({
  // A client account with the sections a client usually has.
  getUserModules: async () => ["vehiculos", "historial", "analiticas"],
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const DEVICE = { piazza: id(11), dhl: id(12), other: id(13) };
const VEHICLE = { piazza: id(21), dhl: id(22), other: id(23) };
const RANGE = "from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z";

let app: Awaited<ReturnType<typeof buildApp>>;

const as = (role: string, allowedArea: string | null, orgId = ORG) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: id(90), orgId, role, allowedArea } as never)}`,
});
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (
      id uuid PRIMARY KEY, org_id uuid, imei varchar(20) NOT NULL UNIQUE, model varchar(50) NOT NULL DEFAULT 'FMB204',
      serial_number varchar(32), firmware varchar(32), status varchar(20) NOT NULL DEFAULT 'active',
      source varchar(20) NOT NULL DEFAULT 'teltonika', last_seen_at timestamptz, green_driving_since timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20), fleet_group varchar(50),
      device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
    );
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
    INSERT INTO devices (id, org_id, imei) VALUES
      ('${DEVICE.piazza}', '${ORG}', '350000000000011'), ('${DEVICE.dhl}', '${ORG}', '350000000000012'), ('${DEVICE.other}', '${OTHER_ORG}', '350000000000013');
    INSERT INTO vehicles (id, org_id, name, plate, fleet_group, device_id) VALUES
      ('${VEHICLE.piazza}', '${ORG}', 'Piazza van', 'PZ111AA', 'PIAZZA', '${DEVICE.piazza}'),
      ('${VEHICLE.dhl}', '${ORG}', 'DHL van', 'DH222BB', 'DHL', '${DEVICE.dhl}'),
      ('${VEHICLE.other}', '${OTHER_ORG}', 'Other org van', 'OT333CC', 'PIAZZA', '${DEVICE.other}');
    INSERT INTO positions (device_id, ts, lat, lng, speed) VALUES
      ('${DEVICE.piazza}', '2026-10-10T10:00:00Z', 45.1, 9.1, 40),
      ('${DEVICE.dhl}', '2026-10-10T10:00:00Z', 45.2, 9.2, 50),
      ('${DEVICE.other}', '2026-10-10T10:00:00Z', 45.3, 9.3, 60);
    INSERT INTO device_events (device_id, ts, type) VALUES
      ('${DEVICE.piazza}', '2026-10-10T10:00:00Z', 'ignition_change'),
      ('${DEVICE.dhl}', '2026-10-10T10:00:00Z', 'ignition_change');
  `);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("a client restricted to one área", () => {
  const piazza = () => as("viewer", "PIAZZA");

  it("lists only the vehicles and devices of their own área", async () => {
    const vehicles = (await get("/vehicles", piazza())).json() as Array<{ id: string }>;
    expect(vehicles.map((v) => v.id)).toEqual([VEHICLE.piazza]);
    const devices = (await get("/devices", piazza())).json() as Array<{ id: string }>;
    expect(devices.map((d) => d.id)).toEqual([DEVICE.piazza]);
  });

  it("reads its own vehicle: sheet, latest position, history and events", async () => {
    expect((await get(`/vehicles/${VEHICLE.piazza}`, piazza())).statusCode).toBe(200);
    expect((await get(`/vehicles/${VEHICLE.piazza}/positions/latest`, piazza())).statusCode).toBe(200);
    expect((await get(`/vehicles/${VEHICLE.piazza}/positions?${RANGE}`, piazza())).statusCode).toBe(200);
    expect((await get(`/vehicles/${VEHICLE.piazza}/events?${RANGE}`, piazza())).statusCode).toBe(200);
  });

  it("gets a 404, never the data, for a vehicle of another área", async () => {
    for (const path of ["", "/positions/latest", `/positions?${RANGE}`, `/events?${RANGE}`]) {
      const res = await get(`/vehicles/${VEHICLE.dhl}${path}`, piazza());
      expect(res.statusCode, path || "vehicle").toBe(404);
      expect(res.body).not.toContain("DH222BB");
      expect(res.body).not.toContain("45.2");
    }
  });

  it("gets a 404 for a vehicle of another organization, even one in the same área", async () => {
    for (const path of ["", "/positions/latest", `/positions?${RANGE}`, `/events?${RANGE}`]) {
      expect((await get(`/vehicles/${VEHICLE.other}${path}`, piazza())).statusCode, path || "vehicle").toBe(404);
    }
  });

  it("is not let into the organization-wide sections", async () => {
    expect((await get("/sims", piazza())).statusCode).toBe(403);
  });

  it("without a token sees nothing", async () => {
    for (const url of ["/vehicles", "/devices", `/vehicles/${VEHICLE.piazza}/positions/latest`]) {
      expect((await get(url, {})).statusCode, url).toBe(401);
    }
  });
});

describe("the other direction and the unrestricted owner", () => {
  it("keeps a DHL client out of Piazza", async () => {
    const dhl = as("viewer", "DHL");
    expect(((await get("/vehicles", dhl)).json() as Array<{ id: string }>).map((v) => v.id)).toEqual([VEHICLE.dhl]);
    expect((await get(`/vehicles/${VEHICLE.piazza}`, dhl)).statusCode).toBe(404);
    expect((await get(`/vehicles/${VEHICLE.piazza}/positions/latest`, dhl)).statusCode).toBe(404);
  });

  it("lets the organization's owner see every área of their own organization, and nothing of another", async () => {
    const owner = as("owner", null);
    const ids = ((await get("/vehicles", owner)).json() as Array<{ id: string }>).map((v) => v.id).sort();
    expect(ids).toEqual([VEHICLE.piazza, VEHICLE.dhl].sort());
    expect((await get(`/vehicles/${VEHICLE.other}`, owner)).statusCode).toBe(404);
  });
});
