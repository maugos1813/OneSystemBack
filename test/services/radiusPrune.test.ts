import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Radius Velocity vehicles keep only their newest report; Teltonika ones keep their whole route. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/realtime/gateway.js", () => ({ publishPosition: () => undefined }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { pruneSupersededPositions } = await import("../../src/services/radiusVelocity.service.js");
const { positions } = await import("../../src/db/schema/index.js");
const { asc, eq } = await import("drizzle-orm");
const { db } = clientModule;

const RADIUS = "00000000-0000-0000-0000-0000000000a1";
const TELTONIKA = "00000000-0000-0000-0000-0000000000b1";
const NOW = new Date("2026-10-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeAll(async () => {
  await clientModule.__pg.exec(`
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
});

const row = (deviceId: string, ts: Date) => ({ deviceId, ts, lat: 45, lng: 9, altitude: 0, angle: 0, satellites: null, speed: 0, priority: 0, ioData: {} });

describe("pruneSupersededPositions", () => {
  it("keeps only the newest report of the device, deleting the recent ones before it", async () => {
    await db.insert(positions).values([row(RADIUS, hoursAgo(5)), row(RADIUS, hoursAgo(3)), row(RADIUS, hoursAgo(1))]);
    await pruneSupersededPositions(RADIUS, hoursAgo(1), NOW);
    const left = await db.select().from(positions).where(eq(positions.deviceId, RADIUS));
    expect(left.map((r) => r.ts.getTime())).toEqual([hoursAgo(1).getTime()]);
  });

  it("never touches another device's route", async () => {
    await db.insert(positions).values([row(RADIUS, hoursAgo(3)), row(RADIUS, hoursAgo(1)), row(TELTONIKA, hoursAgo(5)), row(TELTONIKA, hoursAgo(2))]);
    await pruneSupersededPositions(RADIUS, hoursAgo(1), NOW);
    expect(await db.select().from(positions).where(eq(positions.deviceId, TELTONIKA)).orderBy(asc(positions.ts))).toHaveLength(2);
  });

  it("does not reach back into old (compressed) chunks, only the last two days", async () => {
    const old = new Date(NOW.getTime() - 10 * 24 * 3_600_000);
    await db.insert(positions).values([row(RADIUS, old), row(RADIUS, hoursAgo(30)), row(RADIUS, hoursAgo(1))]);
    await pruneSupersededPositions(RADIUS, hoursAgo(1), NOW);
    const left = await db.select().from(positions).where(eq(positions.deviceId, RADIUS));
    expect(left.map((r) => r.ts.getTime())).toEqual([old.getTime(), hoursAgo(1).getTime()]);
  });

  it("is a no-op when there is nothing older", async () => {
    await db.insert(positions).values([row(RADIUS, hoursAgo(1))]);
    await pruneSupersededPositions(RADIUS, hoursAgo(1), NOW);
    expect(await db.select().from(positions)).toHaveLength(1);
  });
});

describe("the retention migration", () => {
  it("drops route history and events after 3 months, in both hypertables", () => {
    const sql = readFileSync(new URL("../../drizzle/0022_positions_retention.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/add_retention_policy\('positions', INTERVAL '3 months'/);
    expect(sql).toMatch(/add_retention_policy\('device_events', INTERVAL '3 months'/);
  });
});
