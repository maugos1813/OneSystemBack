import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A long route is thinned over its whole range (keeping the speeding peaks) instead of cut at the newest rows. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const position = await import("../../src/services/position.service.js");
const { positions } = await import("../../src/db/schema/index.js");
const { db } = clientModule;
const pg = clientModule.__pg;

const DEVICE = "00000000-0000-0000-0000-0000000000d1";
const T0 = new Date("2026-10-17T10:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE devices (id uuid PRIMARY KEY);
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0,
      angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0,
      priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts)
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM positions");
});

async function drive(count: number, speedAt: (i: number) => number) {
  await db.insert(positions).values(
    Array.from({ length: count }, (_, i) => ({
      deviceId: DEVICE,
      ts: at(i * 3),
      lat: 45 + i / 10_000,
      lng: 9,
      altitude: 0,
      angle: 0,
      satellites: 9,
      speed: speedAt(i),
      priority: 0,
      ioData: {},
    })),
  );
}

describe("thinningKeep", () => {
  const rows = (speeds: number[]) => speeds.map((speed, i) => ({ ts: at(i), speed }));

  it("keeps everything when it already fits", () => {
    expect(position.thinningKeep(rows([1, 2, 3]), 5)).toHaveLength(3);
  });

  it("keeps the fastest report of each run, and both ends of the route", () => {
    const kept = position.thinningKeep(rows([0, 9, 1, 2, 80, 3, 4, 5, 0]), 3);
    expect(kept.map((ts) => ts.getTime())).toEqual([at(0).getTime(), at(4).getTime(), at(8).getTime()]);
  });
});

describe("getPositionHistory with maxPoints", () => {
  it("covers the whole range, newest first, instead of only its newest rows", async () => {
    await drive(3000, (i) => (i === 1500 ? 150 : 40));
    const cut = await position.getPositionHistory({ deviceId: DEVICE, limit: 1000 });
    expect(cut.at(-1)!.ts.getTime()).toBeGreaterThan(at(1999 * 3).getTime()); // the old behaviour: the start is lost

    const thinned = await position.getPositionHistory({ deviceId: DEVICE, maxPoints: 500 });
    expect(thinned.length).toBeLessThanOrEqual(500);
    expect(thinned[0]!.ts.getTime()).toBe(at(2999 * 3).getTime());
    expect(thinned.at(-1)!.ts.getTime()).toBe(at(0).getTime());
    expect(thinned.some((p) => p.speed === 150)).toBe(true);
  });

  it("returns a short range untouched, and nothing for an empty one", async () => {
    await drive(10, () => 30);
    expect(await position.getPositionHistory({ deviceId: DEVICE, maxPoints: 500 })).toHaveLength(10);
    expect(await position.getPositionHistory({ deviceId: DEVICE, maxPoints: 500, from: at(100_000) })).toEqual([]);
  });
});
