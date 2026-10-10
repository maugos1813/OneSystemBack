import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDrivingStyle: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

vi.mock("../../src/services/drivingStyle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/drivingStyle.service.js")>()),
  getDrivingStyle: mocks.getDrivingStyle,
}));

vi.mock("../../src/services/apiKey.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/apiKey.service.js")>()),
  authenticateApiKey: mocks.authenticateApiKey,
}));

const { buildApp } = await import("../../src/api/app.js");

const KEY = "osk_live_0000000000000000000000000000000000000000000000";
const VEHICLE_ID = "123e4567-e89b-12d3-a456-426614174000";
const AUTH = { authorization: `Bearer ${KEY}` };

const vehicleStyle = (overrides: object = {}) => ({
  vehicleId: VEHICLE_ID,
  name: "VAN-1",
  plate: "AB123CD",
  fleetGroup: "DHL",
  samples: 120,
  distanceKm: 8.4,
  drivingHours: 0.2,
  trips: 1,
  quality: "insufficient_data",
  scores: null,
  incidents: { harshBraking: 2, harshAcceleration: 1, harshCornering: 0, speeding: 3 },
  incidentsPer100Km: null,
  ...overrides,
});

const serviceResult = (over: Record<string, unknown> = {}) => ({
  days: 7,
  speedLimitKmh: 120,
  from: new Date("2026-10-02T00:00:00Z"),
  to: new Date("2026-10-09T00:00:00Z"),
  vehicles: [vehicleStyle()],
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mocks.getDrivingStyle.mockReset();
  mocks.getDrivingStyle.mockResolvedValue(serviceResult());
  mocks.authenticateApiKey.mockReset();
  mocks.authenticateApiKey.mockResolvedValue({ orgId: "org-1", keyId: `key-${Math.random()}`, allowedArea: null });
});

const ENDPOINTS = [
  { name: "fleet", url: "/v1/driving-style" },
  { name: "vehicle", url: `/v1/vehicles/${VEHICLE_ID}/driving-style` },
] as const;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe.each(ENDPOINTS)("GET $name driving-style with from/to", ({ url }) => {
  const get = (query: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url: `${url}?${query}`, headers });

  it("rejects `from` without `to`, and `to` without `from`, with a clear message", async () => {
    for (const query of [`from=${hoursAgo(5)}`, `to=${hoursAgo(1)}`]) {
      const res = await get(query);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toMatch(/`from` and `to` must be sent together/);
    }
    expect(mocks.getDrivingStyle).not.toHaveBeenCalled();
  });

  it("rejects from >= to", async () => {
    const res = await get(`from=${hoursAgo(1)}&to=${hoursAgo(3)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/`from` must be earlier than `to`/);

    const equal = await get(`from=${hoursAgo(2)}&to=${hoursAgo(2)}`);
    expect(equal.statusCode).toBe(400);
  });

  it("rejects a range longer than 31 days", async () => {
    const res = await get(`from=${hoursAgo(24 * 32)}&to=${hoursAgo(1)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/can't exceed 31 days/);

    expect((await get(`from=${hoursAgo(24 * 30)}&to=${hoursAgo(1)}`)).statusCode).toBe(200);
  });

  it("rejects a `from` that is still in the future", async () => {
    const res = await get(`from=${hoursAhead(1)}&to=${hoursAhead(3)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/`from` must be in the past/);
  });

  it("rejects values that are not ISO 8601 date-times", async () => {
    for (const query of ["from=yesterday&to=today", `from=${hoursAgo(5)}&to=not-a-date`]) {
      expect((await get(query)).statusCode, query).toBe(400);
    }
  });

  it("clips a `to` in the future to now instead of failing", async () => {
    const before = Date.now();
    const res = await get(`from=${hoursAgo(2)}&to=${hoursAhead(5)}`);
    expect(res.statusCode).toBe(200);

    const args = mocks.getDrivingStyle.mock.calls[0]![0];
    expect(args.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(args.to.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("uses from/to INSTEAD of `days` when both are sent, and says so", async () => {
    const from = hoursAgo(10);
    const to = hoursAgo(2);
    mocks.getDrivingStyle.mockResolvedValue(serviceResult({ days: null, from: new Date(from), to: new Date(to) }));

    const res = await get(`days=3&from=${from}&to=${to}`);
    expect(res.statusCode).toBe(200);

    const args = mocks.getDrivingStyle.mock.calls[0]![0];
    expect(args.from).toEqual(new Date(from));
    expect(args.to).toEqual(new Date(to));
    // `days` plays no part: the response reports the stretch actually used and no `days`.
    const body = res.json();
    expect(body.days).toBeNull();
    expect(body.from).toBe(new Date(from).toISOString());
    expect(body.to).toBe(new Date(to).toISOString());
  });

  it("returns the raw counts and distance even though scores is null", async () => {
    const res = await get(`from=${hoursAgo(3)}&to=${hoursAgo(1)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const vehicle = body.vehicles ? body.vehicles[0] : body;
    expect(vehicle.scores).toBeNull();
    expect(vehicle.quality).toBe("insufficient_data");
    expect(vehicle.incidents).toEqual({ harshBraking: 2, harshAcceleration: 1, harshCornering: 0, speeding: 3 });
    expect(vehicle).toMatchObject({ distanceKm: 8.4, drivingHours: 0.2, trips: 1, samples: 120 });
  });

  it("keeps the organisation and the key's área restriction", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ orgId: "org-7", keyId: "key-area", allowedArea: "DHL" });
    await get(`from=${hoursAgo(5)}&to=${hoursAgo(1)}`);
    expect(mocks.getDrivingStyle.mock.calls[0]![0]).toMatchObject({ orgId: "org-7", allowedArea: "DHL" });
  });

  it("without from/to asks the service for exactly what it asked before (days, no window)", async () => {
    const res = await get("days=3&speedLimit=100");
    expect(res.statusCode).toBe(200);

    const args = mocks.getDrivingStyle.mock.calls[0]![0];
    expect(args).toMatchObject({ days: 3, speedLimitKmh: 100, orgId: "org-1" });
    expect(args.from).toBeUndefined();
    expect(args.to).toBeUndefined();
    expect(res.json().days).toBe(7); // as the (mocked) service reported it: `days` is still returned

    await get("");
    expect(mocks.getDrivingStyle.mock.calls[1]![0]).toMatchObject({ days: 7, speedLimitKmh: 120 });
  });

  it("is still refused without a valid API key", async () => {
    expect((await get(`from=${hoursAgo(5)}&to=${hoursAgo(1)}`, {})).statusCode).toBe(401);
  });
});

describe("rate limit", () => {
  it("still applies to these endpoints (per key)", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ orgId: "org-1", keyId: "key-rate-limited", allowedArea: null });
    const first = await app.inject({ method: "GET", url: "/v1/driving-style", headers: AUTH });
    expect(first.headers["x-ratelimit-limit"]).toBe("120");
    expect(Number(first.headers["x-ratelimit-remaining"])).toBeLessThan(120);
  });
});

describe("OpenAPI document", () => {
  it("documents from/to, their priority over `days`, and the raw data returned with null scores", async () => {
    const spec = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json() as {
      paths: Record<string, { get: { description: string; parameters: Array<{ name: string; description?: string; schema: { format?: string } }> } }>;
    };

    for (const path of ["/v1/driving-style", "/v1/vehicles/{id}/driving-style"]) {
      const op = spec.paths[path]!.get;
      const params = Object.fromEntries(op.parameters.map((p) => [p.name, p]));
      expect(params.from?.schema.format).toBe("date-time");
      expect(params.to?.schema.format).toBe("date-time");
      expect(params.days?.description).toMatch(/Se ignora si envías `from` y `to`/);
      expect(params.to?.description).toMatch(/futuro se recorta/);
      expect(op.description).toMatch(/siempre,\s+aunque `scores` sea null/);
      expect(op.description).toMatch(/1 hora/);
    }
  });
});
