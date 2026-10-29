import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The daily km totals the maintenance plans count from, against an in-memory Postgres. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { __pg: PGlite };
const km = await import("../../src/services/dailyKm.service.js");
const pg = clientModule.__pg;

const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const VEHICLE = "00000000-0000-0000-0000-0000000000a1";
const OTHER_DEVICE = "00000000-0000-0000-0000-0000000000d2";
const OTHER_VEHICLE = "00000000-0000-0000-0000-0000000000a2";
const METERS_PER_DEGREE = 111_320;

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid NOT NULL DEFAULT gen_random_uuid(), name varchar(100) NOT NULL DEFAULT 'V', device_id uuid);
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL,
      lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint,
      speed integer NOT NULL DEFAULT 0, priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts)
    );
    CREATE TABLE vehicle_daily_km (
      vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE, day date NOT NULL, km double precision NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (vehicle_id, day)
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM vehicle_daily_km; DELETE FROM positions; DELETE FROM vehicles;
    INSERT INTO vehicles (id, device_id) VALUES ('${VEHICLE}', '${DEVICE}'), ('${OTHER_VEHICLE}', '${OTHER_DEVICE}');`);
});

interface Point {
  at: string;
  lat: number;
  lng?: number;
  speed: number;
}
async function report(device: string, points: Point[]) {
  for (const p of points) {
    await pg.query("INSERT INTO positions (device_id, ts, lat, lng, speed) VALUES ($1, $2, $3, $4, $5)", [device, p.at, p.lat, p.lng ?? 9.2, p.speed]);
  }
}
/** A drive north at 60 km/h reporting every 30 s: 500 m between reports. */
const drive = (start: string, steps: number, lat0 = 45.0): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => ({
    at: new Date(new Date(start).getTime() + i * 30_000).toISOString(),
    lat: lat0 + (i * 500) / METERS_PER_DEGREE,
    speed: 60,
  }));

const dailyOf = async (vehicle = VEHICLE) =>
  Object.fromEntries((await km.listDailyKm([vehicle])).get(vehicle)!.map((r) => [r.day, Math.round(r.km * 10) / 10]));

describe("recomputeDailyKm", () => {
  it("adds up what a vehicle drove: 20 reports of 500 m are 10 km", async () => {
    await report(DEVICE, drive("2026-10-10T08:00:00Z", 20));
    expect(await km.recomputeDailyKm("2026-10-01")).toBe(1);
    expect(await dailyOf()).toEqual({ "2026-10-10": 10 });
  });

  it("is steady: running it again, even over a wider window, gives the same totals instead of adding", async () => {
    await report(DEVICE, drive("2026-10-10T08:00:00Z", 20));
    await km.recomputeDailyKm("2026-10-01");
    await km.recomputeDailyKm("2026-09-01");
    expect(await dailyOf()).toEqual({ "2026-10-10": 10 });
  });

  it("does not count a parked vehicle's GPS wander as kilometres", async () => {
    const wander: Point[] = Array.from({ length: 200 }, (_, i) => ({
      at: new Date(Date.parse("2026-10-10T20:00:00Z") + i * 4000).toISOString(),
      lat: 45 + (i % 2 === 0 ? 0 : 6) / METERS_PER_DEGREE, // 6 m back and forth, 3 km over the night if it counted
      speed: 0,
    }));
    await report(DEVICE, wander);
    await km.recomputeDailyKm("2026-10-01");
    expect(await dailyOf()).toEqual({});
  });

  it("skips a gap too long to trust and a GPS jump no vehicle could make", async () => {
    await report(DEVICE, [
      { at: "2026-10-10T08:00:00Z", lat: 45.0, speed: 60 },
      { at: "2026-10-10T08:00:30Z", lat: 45.0045, speed: 60 }, // 500 m: counts
      { at: "2026-10-10T08:20:00Z", lat: 45.1, speed: 60 }, // 20 minutes of silence: not counted
      { at: "2026-10-10T08:20:30Z", lat: 46.0, speed: 60 }, // 100 km in 30 s: a jump, not counted
      { at: "2026-10-10T08:21:00Z", lat: 46.0045, speed: 60 }, // 500 m: counts
    ]);
    await km.recomputeDailyKm("2026-10-01");
    expect(await dailyOf()).toEqual({ "2026-10-10": 1 });
  });

  it("ignores reports with no GPS fix", async () => {
    await report(DEVICE, [
      { at: "2026-10-10T08:00:00Z", lat: 45.0, speed: 60 },
      { at: "2026-10-10T08:00:30Z", lat: 0, lng: 0, speed: 60 },
      { at: "2026-10-10T08:01:00Z", lat: 45.009, speed: 60 },
    ]);
    await km.recomputeDailyKm("2026-10-01");
    // 08:00:00 -> 08:01:00 is 1 km over a 60 s gap, once the no-fix report is out of the way
    expect(await dailyOf()).toEqual({ "2026-10-10": 1 });
  });

  it("puts each stretch on its Rome calendar day, midnight included", async () => {
    // 23:30Z on the 28th is 00:30 on the 29th in Rome (UTC+1 after the clocks go back)
    await report(DEVICE, drive("2026-10-28T23:30:00Z", 4));
    await report(DEVICE, drive("2026-10-28T22:00:00Z", 2, 46.0));
    await km.recomputeDailyKm("2026-10-01");
    expect(await dailyOf()).toEqual({ "2026-10-28": 1, "2026-10-29": 2 });
  });

  it("keeps each vehicle's days to itself, and only counts vehicles that have a device", async () => {
    await report(DEVICE, drive("2026-10-10T08:00:00Z", 4));
    await report(OTHER_DEVICE, drive("2026-10-10T09:00:00Z", 10));
    await pg.exec(`INSERT INTO vehicles (id, device_id) VALUES ('00000000-0000-0000-0000-0000000000a3', NULL)`);
    await km.recomputeDailyKm("2026-10-01");
    expect(await dailyOf(VEHICLE)).toEqual({ "2026-10-10": 2 });
    expect(await dailyOf(OTHER_VEHICLE)).toEqual({ "2026-10-10": 5 });
  });

  it("only looks from the day asked for", async () => {
    await report(DEVICE, drive("2026-10-05T08:00:00Z", 4));
    await report(DEVICE, drive("2026-10-10T08:00:00Z", 4));
    await km.recomputeDailyKm("2026-10-08");
    expect(await dailyOf()).toEqual({ "2026-10-10": 2 });
  });
});

describe("reading the totals", () => {
  it("adds the days after a given day, never the day itself", () => {
    const rows = [
      { day: "2026-10-01", km: 80 },
      { day: "2026-10-02", km: 120.5 },
      { day: "2026-10-03", km: 200 },
    ];
    expect(km.kmAfterDay(rows, "2026-10-01")).toBe(320.5);
    expect(km.kmAfterDay(rows, "2026-10-03")).toBe(0);
    expect(km.kmAfterDay([], "2026-10-01")).toBe(0);
  });

  it("knows the Rome day of an instant and does calendar arithmetic on days", () => {
    expect(km.romeDay(new Date("2026-10-28T23:30:00Z"))).toBe("2026-10-29");
    expect(km.romeDay(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01"); // summer time: UTC+2
    expect(km.romeDay(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
    expect(km.addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(km.addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
