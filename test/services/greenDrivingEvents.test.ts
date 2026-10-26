import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** The harsh-driving events a Teltonika reports itself (AVL 253: 1 acceleration, 2 braking, 3 cornering), counted once per event. */

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/config/env.js", () => ({ env: { RADIUS_VELOCITY_CUSTOMER_ID: "1" } }));
vi.mock("../../src/config/logger.js", () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
vi.mock("../../src/services/radiusVelocity.service.js", () => ({ radiusAccessToken: async () => "t" }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { queryGreenDrivingCounts } = await import("../../src/services/drivingStyle.service.js");
const { positions } = await import("../../src/db/schema/index.js");
const { db } = clientModule;
const pg = clientModule.__pg;

const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";
const T0 = new Date("2026-10-20T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE positions (
      id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL,
      lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL, angle integer NOT NULL,
      satellites smallint, speed integer NOT NULL, priority smallint NOT NULL, io_data jsonb NOT NULL,
      PRIMARY KEY (id, ts)
    );
  `);
});
afterAll(async () => {
  await pg.close();
});

const report = (deviceId: string, ts: Date, io: Record<string, number | string>) =>
  db.insert(positions).values({ deviceId, ts, lat: 45, lng: 7, altitude: 0, angle: 0, satellites: 10, speed: 40, priority: 0, ioData: io });

describe("queryGreenDrivingCounts", () => {
  it("counts each event once, even when the device repeats its record while the event lasts", async () => {
    // One braking event reported on three consecutive seconds, then a second one a minute later.
    await report(A, at(0), { "253": 2, "254": 31 });
    await report(A, at(1), { "253": 2, "254": 33 });
    await report(A, at(2), { "253": "2", "254": 30 });
    await report(A, at(60), { "253": 2 });
    // An acceleration and a cornering, and noise that is not an event.
    await report(A, at(10), { "253": 1 });
    await report(A, at(20), { "253": 3 });
    await report(A, at(30), { "253": 0 });
    await report(A, at(40), { "239": 1 });
    // Another device, and a report outside the window.
    await report(B, at(5), { "253": 2 });
    await report(A, at(100_000), { "253": 2 });

    const counts = await queryGreenDrivingCounts([A, B], at(-10), at(3_600));
    expect(counts.get(A)).toEqual({ harshAcceleration: 1, harshBraking: 2, harshCornering: 1 });
    expect(counts.get(B)).toEqual({ harshAcceleration: 0, harshBraking: 1, harshCornering: 0 });
  });

  it("gives nothing for a device with no events, or no devices", async () => {
    const none = "00000000-0000-0000-0000-0000000000c1";
    expect((await queryGreenDrivingCounts([none], at(-10), at(3_600))).has(none)).toBe(false);
    expect((await queryGreenDrivingCounts([], at(-10), at(3_600))).size).toBe(0);
  });
});
