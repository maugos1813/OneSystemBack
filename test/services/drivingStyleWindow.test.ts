import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SQL-level tests of the exact-window driving style. The real queries run against an
 * in-memory Postgres (PGlite) holding a synthetic `positions` table, so the window,
 * boundary and scoring behaviour is exercised for real — not mocked.
 */

const harness = vi.hoisted(() => ({ pg: null as unknown as { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }, executeCalls: 0 }));

vi.mock("../../src/db/client.js", () => ({
  db: {
    execute: async (query: SQL) => {
      harness.executeCalls++;
      const { sql, params } = new PgDialect().sqlToQuery(query);
      const result = await harness.pg.query(sql, params);
      return { rows: result.rows };
    },
  },
  pool: {},
}));

const VEHICLE = {
  id: "00000000-0000-0000-0000-0000000000a1",
  name: "VAN-1",
  plate: "AB123CD",
  fleetGroup: "DHL",
  deviceId: "00000000-0000-0000-0000-0000000000d1",
};
vi.mock("../../src/services/vehicle.service.js", () => ({
  listVehiclesForOrg: async () => [VEHICLE],
}));

const { getDrivingStyle, queryStats, summarize } = await import("../../src/services/drivingStyle.service.js");

const DEVICE = VEHICLE.deviceId;
const M_PER_DEG = 111_320;
const day = (hhmmss: string) => new Date(`2026-10-09T${hhmmss}Z`);

interface Sample {
  ts: Date;
  speed: number;
}

/** Drives due north from `lat0`, one report every `stepS` seconds, with speeds from `speedAt(t)`. */
function drive(from: string, to: string, speedAt: (secondsIntoStretch: number) => number, stepS = 4, lat0 = 45): Sample[] & { endLat: number } {
  const start = day(from).getTime();
  const end = day(to).getTime();
  const out: Sample[] = [];
  let lat = lat0;
  for (let t = start; t <= end; t += stepS * 1000) {
    const speed = speedAt((t - start) / 1000);
    out.push({ ts: new Date(t), speed });
    lat += ((speed / 3.6) * stepS) / M_PER_DEG;
  }
  return Object.assign(out, { endLat: lat });
}

async function insert(samples: Sample[], lat0 = 45) {
  let lat = lat0;
  let prev: Sample | undefined;
  for (const s of samples) {
    if (prev) lat += ((prev.speed / 3.6) * ((s.ts.getTime() - prev.ts.getTime()) / 1000)) / M_PER_DEG;
    await harness.pg.query(
      "insert into positions (device_id, ts, lat, lng, speed, angle) values ($1, $2, $3, $4, $5, $6)",
      [DEVICE, s.ts.toISOString(), lat, 9, s.speed, 0],
    );
    prev = s;
  }
}

beforeAll(async () => {
  harness.pg = new PGlite() as unknown as typeof harness.pg;
  await harness.pg.query(
    "create table positions (device_id uuid not null, ts timestamptz not null, lat double precision not null, lng double precision not null, speed integer not null, angle integer not null)",
    [],
  );

  // One van, one day, several drivers (reports every 4 s):
  //  08:00:00-09:59:36  careful driver, steady 80 km/h
  //  09:59:40-10:00:20  hand-over #1 (10:00:00): the hard-braking pair 09:59:56 (100) -> 10:00:00 (40) straddles it
  //  10:00:24-12:00:00  aggressive driver, braking 100 -> 40 km/h every 5 minutes
  //                     (inside it, hand-over #2 at 11:00:00: a 130 km/h run from 10:59:52 to 11:00:28)
  //  12:00:04-12:10:00  a short errand at 60 km/h with one stop (hard brake + hard restart)
  const steady80 = () => 80;
  const careful = drive("08:00:00", "09:59:36", steady80);
  const handover1 = drive("09:59:40", "10:00:20", (t) => (t === 16 ? 100 : t === 20 ? 40 : 80)); // 09:59:56 -> 100, 10:00:00 -> 40
  const aggressive1 = drive("10:00:24", "10:59:36", (t) => (Math.round(t) % 300 < 4 ? 100 : Math.round(t) % 300 < 8 ? 40 : 80));
  const handover2 = drive("10:59:40", "11:00:40", (t) => (t >= 12 && t <= 48 ? 130 : 80)); // 130 km/h from 10:59:52 to 11:00:28
  const aggressive2 = drive("11:00:44", "12:00:00", (t) => (Math.round(t) % 300 < 4 ? 100 : Math.round(t) % 300 < 8 ? 40 : 80));
  const errand = drive("12:00:04", "12:10:00", (t) => (Math.round(t) === 300 ? 0 : 60));

  await insert([...careful, ...handover1, ...aggressive1, ...handover2, ...aggressive2, ...errand]);
});

afterAll(async () => {
  await (harness.pg as unknown as PGlite).close();
});

beforeEach(() => {
  harness.executeCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

const LIMIT = 120;
const stats = async (from: string, to: string) => {
  const map = await queryStats([DEVICE], day(from), day(to), LIMIT);
  return map.get(DEVICE);
};

describe("exact from/to window", () => {
  it("scores the same vehicle differently per driver's stretch of the same day", async () => {
    const careful = summarize(await stats("08:00:00", "09:59:36"));
    const aggressive = summarize(await stats("10:00:24", "10:59:36"));

    expect(careful.quality).toBe("full");
    expect(aggressive.quality).toBe("full");
    expect(careful.scores!.overall).toBe(100);
    expect(careful.incidents.harshBraking).toBe(0);
    expect(aggressive.incidents.harshBraking).toBeGreaterThan(10);
    expect(aggressive.scores!.harshBraking!).toBeLessThan(careful.scores!.harshBraking!);
    expect(aggressive.scores!.overall).toBeLessThan(careful.scores!.overall);
  });

  it("reports distance, hours, trips and samples of the stretch, not of the whole day", async () => {
    const morning = summarize(await stats("08:00:00", "09:00:00"));
    const wholeDay = summarize(await stats("08:00:00", "12:10:00"));

    expect(morning.distanceKm).toBeCloseTo(80, 0); // one hour at 80 km/h
    expect(morning.drivingHours).toBeCloseTo(1, 0);
    expect(morning.samples).toBe(901);
    expect(wholeDay.distanceKm).toBeGreaterThan(morning.distanceKm * 3);
    expect(wholeDay.samples).toBeGreaterThan(morning.samples * 3);
  });

  it("a short stretch is insufficient_data, yet still returns incidents, km, trips and samples", async () => {
    const errand = summarize(await stats("12:00:04", "12:10:00"));

    expect(errand.quality).toBe("insufficient_data");
    expect(errand.scores).toBeNull();
    expect(errand.incidentsPer100Km).toBeNull();
    expect(errand.distanceKm).toBeGreaterThan(5);
    expect(errand.distanceKm).toBeLessThan(20);
    expect(errand.trips).toBeGreaterThanOrEqual(1);
    expect(errand.samples).toBeGreaterThan(100);
    expect(errand.drivingHours).toBeGreaterThan(0);
    // the one stop: a hard brake (60 -> 0 in 4 s) and a hard restart (0 -> 60 in 4 s)
    expect(errand.incidents).toEqual({ harshBraking: 1, harshAcceleration: 1, harshCornering: 0, speeding: 0 });
  });

  it("returns real incident counts for a short stretch that contained them", async () => {
    // 10:00:24 -> 10:10:00 is short (the aggressive driver's first minutes) but has hard braking
    const short = summarize(await stats("10:00:24", "10:10:00"));
    expect(short.quality).toBe("insufficient_data");
    expect(short.scores).toBeNull();
    expect(short.incidents.harshBraking).toBeGreaterThanOrEqual(1);
    expect(short.distanceKm).toBeGreaterThan(5);
  });

  it("is no_data, not perfect driving, when nothing was reported in the stretch", async () => {
    expect(summarize(await stats("03:00:00", "04:00:00")).quality).toBe("no_data");
  });

  it("does not count a hard-braking pair that starts before the stretch", async () => {
    // The pair 09:59:56 (100 km/h) -> 10:00:00 (40 km/h) straddles hand-over #1.
    const firstDriver = await stats("09:59:00", "10:00:00"); // both samples inside
    const nextDriver = await stats("10:00:00", "10:00:20"); // only the 10:00:00 sample is inside
    expect(firstDriver!.harshBraking).toBe(1);
    expect(nextDriver!.harshBraking).toBe(0);
  });

  it("evaluates a speeding run crossing the boundary only by the part inside the stretch", async () => {
    // Over 120 km/h from 10:59:52 to 11:00:28; hand-over #2 is at 11:00:00.
    const enoughInside = await stats("11:00:00", "11:00:40"); // 28 s of the run inside
    const onlyTheTail = await stats("11:00:20", "11:00:40"); //  8 s inside -> below the 10 s minimum
    const onlyTheHead = await stats("10:59:00", "11:00:00"); //  8 s inside -> below the 10 s minimum
    const wholeRun = await stats("10:59:00", "11:00:40");

    expect(enoughInside!.speeding).toBe(1);
    expect(onlyTheTail!.speeding).toBe(0);
    expect(onlyTheHead!.speeding).toBe(0);
    expect(wholeRun!.speeding).toBe(1);
  });
});

describe("getDrivingStyle()", () => {
  const baseQuery = { orgId: "org-window-tests", speedLimitKmh: LIMIT, days: 7 };

  it("without from/to behaves exactly like the equivalent explicit window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day("13:00:00"));

    const byDays = await getDrivingStyle({ ...baseQuery, orgId: "org-compat-a", days: 1 });
    const byWindow = await getDrivingStyle({
      ...baseQuery,
      orgId: "org-compat-b",
      from: new Date(day("13:00:00").getTime() - 24 * 3600_000),
      to: day("13:00:00"),
    });

    expect(byDays.days).toBe(1);
    expect(byWindow.days).toBeNull();
    expect(byWindow.from).toEqual(byDays.from);
    expect(byWindow.to).toEqual(byDays.to);
    expect(byWindow.vehicles).toEqual(byDays.vehicles);
  });

  it("reports the window it actually used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day("13:00:00"));
    const result = await getDrivingStyle({ ...baseQuery, orgId: "org-used", from: day("10:00:24"), to: day("12:00:00") });
    expect(result.from).toEqual(day("10:00:24"));
    expect(result.to).toEqual(day("12:00:00"));
  });

  it("never mixes two stretches in the cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day("13:00:00"));
    const org = "org-cache-mix";

    const careful = await getDrivingStyle({ ...baseQuery, orgId: org, from: day("08:00:00"), to: day("09:59:36") });
    const aggressive = await getDrivingStyle({ ...baseQuery, orgId: org, from: day("10:00:24"), to: day("10:59:36") });
    const fasterLimit = await getDrivingStyle({ ...baseQuery, orgId: org, speedLimitKmh: 60, from: day("08:00:00"), to: day("09:59:36") });

    expect(careful.vehicles[0]!.scores!.overall).toBe(100);
    expect(aggressive.vehicles[0]!.scores!.overall).toBeLessThan(100);
    expect(fasterLimit.vehicles[0]!.incidents.speeding).toBeGreaterThan(0); // 80 km/h > 60 km/h: another speed limit, another result
    expect(careful.vehicles[0]!.incidents.speeding).toBe(0);
  });

  it("caches a closed stretch for an hour, but a stretch ending now for only 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day("13:00:00"));

    // closed: ended an hour ago
    const closed = { ...baseQuery, orgId: "org-ttl-closed", from: day("08:00:00"), to: day("12:00:00") };
    await getDrivingStyle(closed);
    const afterFirst = harness.executeCalls;
    vi.setSystemTime(day("13:50:00")); // +50 min
    await getDrivingStyle(closed);
    expect(harness.executeCalls).toBe(afterFirst); // still cached
    vi.setSystemTime(day("14:05:00")); // +65 min
    await getDrivingStyle(closed);
    expect(harness.executeCalls).toBeGreaterThan(afterFirst); // expired

    // open: ends right now
    vi.setSystemTime(day("13:00:00"));
    const open = { ...baseQuery, orgId: "org-ttl-open", from: day("12:00:00"), to: day("13:00:00") };
    await getDrivingStyle(open);
    const afterOpen = harness.executeCalls;
    vi.setSystemTime(day("13:03:00"));
    await getDrivingStyle(open);
    expect(harness.executeCalls).toBe(afterOpen); // within 5 min
    vi.setSystemTime(day("13:06:00"));
    await getDrivingStyle(open);
    expect(harness.executeCalls).toBeGreaterThan(afterOpen); // expired after 5 min
  });
});
