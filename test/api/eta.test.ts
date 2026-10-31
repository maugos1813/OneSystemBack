import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** "How long until the vehicle gets there" over HTTP: who may ask, whose vehicle, and what comes back. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => ["mapa"] }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const { resetEtaState } = await import("../../src/services/eta.service.js");
const { resetEtaLimit } = await import("../../src/api/routes/eta.routes.js");
const pg = clientModule.__pg;

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const DEVICE = { moving: id(12), silent: id(11) };
const VEHICLE = { dhl: id(22), piazza: id(21), noGps: id(23) };

let app: Awaited<ReturnType<typeof buildApp>>;
const as = (role: string, allowedArea: string | null, orgId = ORG, userId = id(90)) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, orgId, role, allowedArea } as never)}`,
});
const ask = (vehicleId: string, to: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url: `/vehicles/${vehicleId}/eta?to=${encodeURIComponent(to)}`, headers });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const answerMaps = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("nominatim")
        ? json([
            {
              lat: "41.9",
              lon: "12.5",
              name: "Roma",
              address: { city: "Roma" },
              display_name: "Roma, Italia",
            },
          ])
        : json({
            code: "Ok",
            routes: [
              {
                distance: 573_400,
                duration: 21_480,
                geometry: {
                  coordinates: [
                    [9.19, 45.46],
                    [12.5, 41.9],
                  ],
                },
              },
            ],
          }),
    ),
  );

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY, org_id uuid, imei varchar(20) NOT NULL UNIQUE, model varchar(50) NOT NULL DEFAULT 'FMB204',
      serial_number varchar(32), firmware varchar(32), status varchar(20) NOT NULL DEFAULT 'active', source varchar(20) NOT NULL DEFAULT 'teltonika',
      last_seen_at timestamptz, green_driving_since timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20), fleet_group varchar(50),
      device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0, brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text, odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz, km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz, odometer_base_day_km double precision, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE positions (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL,
      lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0,
      priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
    INSERT INTO devices (id, org_id, imei) VALUES ('${DEVICE.moving}', '${ORG}', '350000000000012'), ('${DEVICE.silent}', '${ORG}', '350000000000011');
    INSERT INTO vehicles (id, org_id, name, plate, fleet_group, device_id) VALUES
      ('${VEHICLE.dhl}', '${ORG}', 'DHL van', 'DH222BB', 'DHL', '${DEVICE.moving}'),
      ('${VEHICLE.piazza}', '${ORG}', 'Piazza van', 'PZ111AA', 'PIAZZA', '${DEVICE.silent}'),
      ('${VEHICLE.noGps}', '${ORG}', 'No GPS', 'NG000AA', 'DHL', NULL);
    INSERT INTO positions (device_id, ts, lat, lng, speed) VALUES ('${DEVICE.moving}', now() - interval '7 minutes', 45.4642, 9.19, 50);
  `);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

beforeEach(() => {
  resetEtaState();
  resetEtaLimit();
  answerMaps();
});
afterEach(() => vi.unstubAllGlobals());

describe("estimated arrival at an address", () => {
  it("answers with the destination, the road distance and time, and when the vehicle would arrive", async () => {
    const before = Date.now();
    const res = await ask(VEHICLE.dhl, "Roma", as("owner", null));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { arrivalAt: string; durationMin: number; positionAgeMin: number };
    expect(body).toMatchObject({
      vehicleId: VEHICLE.dhl,
      destination: { label: "Roma", lat: 41.9, lng: 12.5 },
      distanceKm: 573.4,
      baseDurationMin: 358,
      durationMin: 412,
      path: [
        [45.46, 9.19],
        [41.9, 12.5],
      ],
      from: { lat: 45.4642, lng: 9.19 },
      positionAgeMin: 7,
    });
    expect(Date.parse(body.arrivalAt) - before).toBeGreaterThan(body.durationMin * 60_000 - 5_000);
  });

  it("has nothing to say about a vehicle with no position, no GPS, or one that is not the caller's", async () => {
    expect((await ask(VEHICLE.piazza, "Roma", as("owner", null))).statusCode).toBe(404);
    expect((await ask(VEHICLE.noGps, "Roma", as("owner", null))).statusCode).toBe(404);
    expect((await ask(VEHICLE.dhl, "Roma", as("owner", null, OTHER_ORG))).statusCode).toBe(404);
    expect((await ask(VEHICLE.dhl, "Roma", as("client", "PIAZZA"))).statusCode).toBe(404);
    expect((await ask(VEHICLE.dhl, "Roma", as("client", "DHL"))).statusCode).toBe(200);
  });

  it("needs a signed-in person and a sensible text", async () => {
    expect(
      (await app.inject({ method: "GET", url: `/vehicles/${VEHICLE.dhl}/eta?to=Roma` })).statusCode,
    ).toBe(401);
    expect((await ask(VEHICLE.dhl, "ab", as("owner", null))).statusCode).toBe(400);
    expect((await ask("not-a-uuid", "Roma", as("owner", null))).statusCode).toBe(400);
  });

  it("holds back someone asking again and again, without affecting anyone else", async () => {
    for (let i = 0; i < 12; i++)
      expect((await ask(VEHICLE.dhl, "Roma", as("owner", null))).statusCode).toBe(200);
    const blocked = await ask(VEHICLE.dhl, "Roma", as("owner", null));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await ask(VEHICLE.dhl, "Roma", as("owner", null, ORG, id(91)))).statusCode).toBe(200);
  });

  it("says the map service failed, instead of inventing a time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const res = await ask(VEHICLE.dhl, "Milano", as("owner", null));
    expect(res.statusCode).toBe(502);
  });
});
