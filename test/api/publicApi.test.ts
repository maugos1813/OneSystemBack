import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { FixedWindowLimiter } from "../../src/api/middlewares/rateLimit.js";
import { isApiKeyRequestAllowed } from "../../src/api/middlewares/auth.middleware.js";
import { scoreFromRate, scoreGrade, summarize, type RawStats } from "../../src/services/drivingStyle.service.js";
import { ignitionFrom, toPublicPosition } from "../../src/services/publicVehicle.service.js";

const KEY = "osk_live_0000000000000000000000000000000000000000000000";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("isApiKeyRequestAllowed", () => {
  it("allows reads on the public /v1 API", () => {
    expect(isApiKeyRequestAllowed("GET", "/v1/vehicles")).toBe(true);
    expect(isApiKeyRequestAllowed("GET", `/v1/vehicles/${UUID}/driving-style?days=7`)).toBe(true);
    expect(isApiKeyRequestAllowed("HEAD", "/v1/vehicles")).toBe(true);
  });

  it("keeps the legacy vehicle-data reads working for existing integrations", () => {
    expect(isApiKeyRequestAllowed("GET", "/vehicles")).toBe(true);
    expect(isApiKeyRequestAllowed("GET", `/vehicles/${UUID}`)).toBe(true);
    expect(isApiKeyRequestAllowed("GET", `/vehicles/${UUID}/positions/latest`)).toBe(true);
    expect(isApiKeyRequestAllowed("GET", `/vehicles/${UUID}/positions?limit=10`)).toBe(true);
    expect(isApiKeyRequestAllowed("GET", `/vehicles/${UUID}/events`)).toBe(true);
  });

  it("refuses every write, whatever the path", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isApiKeyRequestAllowed(method, "/vehicles")).toBe(false);
      expect(isApiKeyRequestAllowed(method, `/vehicles/${UUID}`)).toBe(false);
      expect(isApiKeyRequestAllowed(method, "/v1/vehicles")).toBe(false);
    }
  });

  it("refuses reads outside vehicle data (settings, team, geofences, devices, tolls, keys)", () => {
    for (const path of ["/settings", "/users", "/geofences", "/devices", "/tolls/passages", "/api-keys", "/products", "/me"]) {
      expect(isApiKeyRequestAllowed("GET", path)).toBe(false);
    }
  });

  it("does not let a path trick past the legacy allowlist", () => {
    expect(isApiKeyRequestAllowed("GET", "/vehicles/../settings")).toBe(false);
    expect(isApiKeyRequestAllowed("GET", `/vehicles/${UUID}/positions/latest/extra`)).toBe(false);
  });
});

describe("API keys over HTTP", () => {
  // 403 from the API-key guard; the key-management routes only accept login sessions, so
  // they answer 401 instead. Either way the request is refused before touching any data.
  it("are refused on writes before any database lookup", async () => {
    const app = await buildApp();
    for (const [method, url] of [
      ["POST", "/vehicles"],
      ["PATCH", `/vehicles/${UUID}`],
      ["DELETE", `/vehicles/${UUID}`],
      ["POST", "/geofences"],
      ["PATCH", "/settings"],
      ["POST", "/api-keys"],
      ["PATCH", `/tolls/passages/${UUID}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${KEY}` }, payload: {} });
      expect([401, 403], `${method} ${url}`).toContain(res.statusCode);
    }
    await app.close();
  });

  it("get 403 when reading internal endpoints", async () => {
    const app = await buildApp();
    for (const url of ["/settings", "/geofences", "/devices", "/users", "/tolls/passages"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } });
      expect(res.statusCode, url).toBe(403);
    }
    await app.close();
  });

  it("are not required for /v1 docs, but /v1 data needs a key", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/v1/docs" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/vehicles" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("public OpenAPI document", () => {
  it("only contains read operations under /v1", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { paths: Record<string, Record<string, unknown>> };

    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/v1/"), path).toBe(true);
      expect(Object.keys(spec.paths[path]!), path).toEqual(["get"]);
    }
    expect(paths).toContain("/v1/driving-style");
    expect(paths).toContain("/v1/vehicles/{id}/driving-style");
    await app.close();
  });

  it("keeps /v1 out of the internal /docs document", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const spec = res.json() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).some((p) => p.startsWith("/v1"))).toBe(false);
    await app.close();
  });
});

describe("FixedWindowLimiter", () => {
  it("allows up to the limit, then blocks until the window rolls over", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.hit("k").allowed)).toEqual([true, true, true]);
    const blocked = limiter.hit("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);

    now += 60_000;
    expect(limiter.hit("k").allowed).toBe(true);
  });

  it("counts each key separately", () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.hit("b").allowed).toBe(true);
  });
});

describe("driving-style scores", () => {
  const stats = (over: Partial<RawStats> = {}): RawStats => ({
    samples: 10_000,
    distanceKm: 1000,
    denseKm: 990,
    movingSeconds: 50_000,
    trips: 8,
    harshBraking: 0,
    harshAcceleration: 0,
    harshCornering: 0,
    speeding: 0,
    ...over,
  });

  it("scales by distance: the same incidents over more kilometres score better", () => {
    expect(scoreFromRate(0)).toBe(100);
    expect(scoreFromRate(2)).toBe(90);
    expect(scoreFromRate(100)).toBe(1);

    const shortRun = summarize(stats({ distanceKm: 100, harshBraking: 10 }));
    const longRun = summarize(stats({ distanceKm: 1000, harshBraking: 10 }));
    expect(shortRun.scores!.harshBraking).toBe(50); // 10 per 100 km
    expect(longRun.scores!.harshBraking).toBe(95); // 1 per 100 km
  });

  it("averages the four categories into overall and grades it", () => {
    const s = summarize(stats({ harshBraking: 28, harshAcceleration: 18, harshCornering: 26, speeding: 103 }));
    expect(s.quality).toBe("full");
    expect(s.incidentsPer100Km).toEqual({ harshBraking: 2.8, harshAcceleration: 1.8, harshCornering: 2.6, speeding: 10.3 });
    expect(s.scores).toMatchObject({ harshBraking: 86, harshAcceleration: 91, harshCornering: 87, speeding: 49, overall: 78, grade: "A" });
  });

  it("does not score tiny distances, and says why", () => {
    const s = summarize(stats({ distanceKm: 5, harshBraking: 3 }));
    expect(s.quality).toBe("insufficient_data");
    expect(s.scores).toBeNull();
    expect(s.incidentsPer100Km).toBeNull();
  });

  it("reports no data as no data, never as perfect driving", () => {
    expect(summarize(undefined).quality).toBe("no_data");
    expect(summarize(undefined).scores).toBeNull();
    expect(summarize(stats({ samples: 0 })).scores).toBeNull();
  });

  it("scores only speed when the device reports too sparsely to see harsh events", () => {
    const s = summarize(stats({ denseKm: 100, speeding: 20 })); // 10% dense coverage
    expect(s.quality).toBe("speeding_only");
    expect(s.scores).toMatchObject({ harshBraking: null, harshAcceleration: null, harshCornering: null, speeding: 90, overall: 90 });
    expect(s.incidents.harshBraking).toBeNull();
  });

  it("grades like the app", () => {
    expect([95, 80, 65, 45, 10].map(scoreGrade)).toEqual(["A+", "A", "B", "C", "D"]);
  });
});

describe("public serializers", () => {
  it("derive ignition from the raw IO element, and null when the source doesn't report it", () => {
    expect(ignitionFrom({ "239": 1 })).toBe(true);
    expect(ignitionFrom({ "239": "1" })).toBe(true);
    expect(ignitionFrom({ "239": 0 })).toBe(false);
    expect(ignitionFrom({})).toBeNull();
  });

  it("never leak internal columns", () => {
    const position = toPublicPosition({
      ts: new Date(),
      lat: 1,
      lng: 2,
      speed: 3,
      angle: 4,
      altitude: 5,
      satellites: null,
      ioData: { "239": 1 },
      // extra database columns that must not pass through
      ...({ id: "internal", deviceId: "internal", priority: 1 } as object),
    });
    expect(Object.keys(position).sort()).toEqual(
      ["altitude", "angle", "ignition", "ioData", "lat", "lng", "satellites", "speed", "ts"].sort(),
    );
  });
});
