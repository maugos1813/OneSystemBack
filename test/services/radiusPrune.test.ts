import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Radius Velocity keeps 7 days of route history, Teltonika keeps 3 months (dropped by TimescaleDB, not by the app). */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/realtime/gateway.js", () => ({ publishPosition: () => undefined }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { pruneRadiusHistory, RADIUS_HISTORY_DAYS } = await import("../../src/services/radiusVelocity.service.js");
const { positions, devices } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

const RADIUS = "00000000-0000-0000-0000-0000000000a1";
const TELTONIKA = "00000000-0000-0000-0000-0000000000b1";
const NOW = new Date("2026-10-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 3_600_000);

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE device_status AS ENUM ('unclaimed', 'active', 'disabled');
    CREATE TYPE device_source AS ENUM ('teltonika', 'radius_velocity');
    CREATE TABLE devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, imei varchar(20) NOT NULL UNIQUE,
      model varchar(50) NOT NULL DEFAULT 'FMB204', serial_number varchar(32), firmware varchar(32),
      status device_status NOT NULL DEFAULT 'unclaimed', source device_source NOT NULL DEFAULT 'teltonika',
      last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL, angle integer NOT NULL,
      satellites smallint, speed integer NOT NULL, priority smallint NOT NULL, io_data jsonb NOT NULL, PRIMARY KEY (id, ts)
    );
  `);
});
afterAll(async () => {
  await clientModule.__pg.close();
});
beforeEach(async () => {
  await db.delete(positions);
  await db.delete(devices);
  await db.insert(devices).values([
    { id: RADIUS, imei: "rv-1", model: "Radius Velocity", source: "radius_velocity" },
    { id: TELTONIKA, imei: "863738074476384", model: "FTC920", source: "teltonika" },
  ]);
});

const row = (deviceId: string, ts: Date) => ({ deviceId, ts, lat: 45, lng: 9, altitude: 0, angle: 0, satellites: null, speed: 0, priority: 0, ioData: {} });

describe("pruneRadiusHistory", () => {
  it("keeps 7 days and deletes what is older, for Radius devices only", async () => {
    expect(RADIUS_HISTORY_DAYS).toBe(7);
    await db.insert(positions).values([row(RADIUS, daysAgo(20)), row(RADIUS, daysAgo(8)), row(RADIUS, daysAgo(6)), row(RADIUS, daysAgo(0.1))]);
    const removed = await pruneRadiusHistory(NOW);
    expect(removed).toBe(2);
    const left = await db.select().from(positions).where(eq(positions.deviceId, RADIUS));
    expect(left.map((r) => r.ts.getTime()).sort()).toEqual([daysAgo(6).getTime(), daysAgo(0.1).getTime()].sort());
  });

  it("never touches a Teltonika route, however old", async () => {
    await db.insert(positions).values([row(TELTONIKA, daysAgo(60)), row(TELTONIKA, daysAgo(10)), row(RADIUS, daysAgo(10))]);
    await pruneRadiusHistory(NOW);
    expect(await db.select().from(positions).where(eq(positions.deviceId, TELTONIKA))).toHaveLength(2);
    expect(await db.select().from(positions).where(eq(positions.deviceId, RADIUS))).toHaveLength(0);
  });

  it("is a no-op when everything is recent", async () => {
    await db.insert(positions).values([row(RADIUS, daysAgo(1)), row(RADIUS, daysAgo(3))]);
    expect(await pruneRadiusHistory(NOW)).toBe(0);
  });
});

describe("the retention migrations", () => {
  const read = (name: string) => readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");

  it("drop route history and events after 3 months in both hypertables", () => {
    const sql = read("0022_positions_retention.sql");
    expect(sql).toMatch(/add_retention_policy\('positions', INTERVAL '3 months'/);
    expect(sql).toMatch(/add_retention_policy\('device_events', INTERVAL '3 months'/);
  });

  it("delay compression to 10 days so the 7-day Radius prune only touches uncompressed rows", () => {
    const sql = read("0023_radius_compression_delay.sql");
    expect(sql).toMatch(/remove_compression_policy\('positions'/);
    expect(sql).toMatch(/add_compression_policy\('positions', INTERVAL '10 days'/);
  });
});
