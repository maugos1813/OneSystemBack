import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** GET /positions/latest: the last position of every vehicle the caller may see, in one answer. */
const mocks = vi.hoisted(() => ({ listVehiclesForOrg: vi.fn(), getLatestPositionsForDevices: vi.fn() }));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  listVehiclesForOrg: mocks.listVehiclesForOrg,
}));
vi.mock("../../src/services/position.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/position.service.js")>()),
  getLatestPositionsForDevices: mocks.getLatestPositionsForDevices,
}));

const { buildApp } = await import("../../src/api/app.js");

describe("the whole fleet's last positions", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mocks.listVehiclesForOrg.mockReset();
    mocks.getLatestPositionsForDevices.mockReset();
  });

  const token = (payload: Record<string, unknown>) => ({ authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role: "viewer", allowedArea: null, ...payload } as never)}` });
  const position = (deviceId: string, lat: number) => ({ id: `p-${deviceId}`, deviceId, ts: new Date("2026-10-17T10:00:00Z"), lat, lng: 9, altitude: 0, angle: 0, satellites: 9, speed: 40, priority: 0, ioData: {} });

  it("answers by vehicle id, only for vehicles that have a device and a position", async () => {
    mocks.listVehiclesForOrg.mockResolvedValue([
      { id: "v1", deviceId: "d1" },
      { id: "v2", deviceId: "d2" },
      { id: "v3", deviceId: null },
    ]);
    mocks.getLatestPositionsForDevices.mockResolvedValue(new Map([["d1", position("d1", 45.1)]]));
    const res = await app.inject({ method: "GET", url: "/positions/latest", headers: token({}) });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["v1"]);
    expect(res.json().v1).toMatchObject({ lat: 45.1, deviceId: "d1", speed: 40 });
    expect(mocks.getLatestPositionsForDevices).toHaveBeenCalledWith(["d1", "d2"]);
  });

  it("looks only at the caller's own organization and applies the área restriction from the token", async () => {
    mocks.listVehiclesForOrg.mockResolvedValue([]);
    mocks.getLatestPositionsForDevices.mockResolvedValue(new Map());
    await app.inject({ method: "GET", url: "/positions/latest", headers: token({ orgId: "org-9", allowedArea: "DHL" }) });
    expect(mocks.listVehiclesForOrg).toHaveBeenCalledWith("org-9", "DHL");
  });

  it("answers an empty object when there is nothing to show", async () => {
    mocks.listVehiclesForOrg.mockResolvedValue([]);
    mocks.getLatestPositionsForDevices.mockResolvedValue(new Map());
    const res = await app.inject({ method: "GET", url: "/positions/latest", headers: token({}) });
    expect(res.json()).toEqual({});
  });

  it("needs a login", async () => {
    expect((await app.inject({ method: "GET", url: "/positions/latest" })).statusCode).toBe(401);
    expect(mocks.listVehiclesForOrg).not.toHaveBeenCalled();
  });

  it("is not available to an API key (those are for /v1)", async () => {
    const res = await app.inject({ method: "GET", url: "/positions/latest", headers: { authorization: "Bearer osk_live_" + "a".repeat(40) } });
    expect(res.statusCode).toBe(403);
  });
});
