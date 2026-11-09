import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The live map's starting point: the last position of many devices in ONE query, answering exactly what one query per device did. */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const service = await import("../../src/services/position.service.js");
const { positions } = await import("../../src/db/schema/index.js");
const { db } = clientModule;
const pg = clientModule.__pg;

const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b2";
const C = "00000000-0000-0000-0000-0000000000c3";
const D = "00000000-0000-0000-0000-0000000000d4";
const NOW = new Date("2026-10-17T10:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const days = (n: number) => ago(n * 24 * 60);

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

const row = (deviceId: string, ts: Date, lat: number, lng: number, extra: Partial<typeof positions.$inferInsert> = {}) => ({
  deviceId,
  ts,
  lat,
  lng,
  altitude: 10,
  angle: 90,
  speed: 0,
  priority: 0,
  ioData: { "239": 1 },
  ...extra,
});

describe("last positions of many devices at once", () => {
  it("gives the newest report of each device", async () => {
    await db.insert(positions).values([
      row(A, ago(30), 45.1, 9.1),
      row(A, ago(5), 45.2, 9.2, { speed: 50 }),
      row(B, ago(60), 41.9, 12.5),
      row(B, ago(10), 41.95, 12.55),
    ]);
    const latest = await service.getLatestPositionsForDevices([A, B]);
    expect(latest.size).toBe(2);
    expect(latest.get(A)).toMatchObject({ lat: 45.2, lng: 9.2, speed: 50, deviceId: A });
    expect(latest.get(B)).toMatchObject({ lat: 41.95, lng: 12.55 });
    expect(latest.get(A)!.ts).toEqual(ago(5));
    expect(latest.get(A)!.ioData).toEqual({ "239": 1 });
  });

  it("leaves out a device that has no reports, and answers an empty list with nothing", async () => {
    await db.insert(positions).values([row(A, ago(5), 45.2, 9.2)]);
    const latest = await service.getLatestPositionsForDevices([A, C]);
    expect([...latest.keys()]).toEqual([A]);
    expect((await service.getLatestPositionsForDevices([])).size).toBe(0);
  });

  it("asks once about a device however many times it is listed", async () => {
    await db.insert(positions).values([row(A, ago(5), 45.2, 9.2)]);
    expect((await service.getLatestPositionsForDevices([A, A, A])).size).toBe(1);
  });

  it("shows the last place it had a fix when the newest report has none (0/0), with the newest report's own data", async () => {
    await db.insert(positions).values([
      row(A, ago(120), 45.5, 9.5, { altitude: 120, angle: 200 }),
      row(A, ago(2), 0, 0, { speed: 0, ioData: { "66": 12000 } }),
    ]);
    const got = (await service.getLatestPositionsForDevices([A])).get(A)!;
    expect(got).toMatchObject({ lat: 45.5, lng: 9.5, altitude: 120, angle: 200 });
    expect(got.ts).toEqual(ago(2));
    expect(got.ioData).toEqual({ "66": 12000 });
  });

  it("leaves a device out when it never had a fix, or only one more than a week before its newest report", async () => {
    await db.insert(positions).values([
      row(B, ago(5), 0, 0),
      row(C, days(10), 41.9, 12.5),
      row(C, ago(5), 0, 0),
    ]);
    const latest = await service.getLatestPositionsForDevices([B, C]);
    expect(latest.size).toBe(0);
  });

  it("answers exactly what asking one device at a time answers, in every one of those cases", async () => {
    await db.insert(positions).values([
      row(A, ago(30), 45.1, 9.1),
      row(A, ago(5), 45.2, 9.2, { speed: 70, satellites: 9, priority: 1 }),
      row(B, days(1), 41.9, 12.5, { altitude: 33, angle: 12 }),
      row(B, ago(3), 0, 0),
      row(C, ago(8), 0, 0),
      row(D, days(10), 40, 14),
      row(D, ago(1), 0, 0),
    ]);
    const ids = [A, B, C, D, "00000000-0000-0000-0000-0000000000ee"];
    const batch = await service.getLatestPositionsForDevices(ids);
    for (const id of ids) {
      const single = await service.getLatestPosition(id);
      const together = batch.get(id);
      if (!single) {
        expect(together).toBeUndefined();
      } else {
        expect(together).toBeDefined();
        // the row id may differ only if two reports share a timestamp: everything else must be identical
        expect({ ...together!, id: single.id }).toEqual(single);
      }
    }
  });
});
