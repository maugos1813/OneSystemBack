import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDevicesForOrg: vi.fn(),
  claimDevice: vi.fn(),
  getDeviceDetail: vi.fn(),
  updateDevice: vi.fn(),
}));

vi.mock("../../src/services/device.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/device.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const { collectLatestIo } = await import("../../src/services/deviceIo.js");

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("collectLatestIo", () => {
  it("keeps the newest value of each element, even when the newest record omits it", () => {
    const t = (min: number) => new Date(Date.UTC(2026, 9, 17, 10, min));
    const io = collectLatestIo([
      { ts: t(0), ioData: { "239": 0, "66": 12100, "21": 3 } },
      { ts: t(10), ioData: { "239": 1, "66": 13900 } },
      { ts: t(20), ioData: { "239": 1, "16": "152000" } },
    ]);
    expect(io.map((r) => r.id)).toEqual([16, 21, 66, 239]);
    expect(io.find((r) => r.id === 66)).toEqual({ id: 66, value: 13900, ts: t(10) });
    expect(io.find((r) => r.id === 21)?.ts).toEqual(t(0));
    expect(io.find((r) => r.id === 239)?.ts).toEqual(t(20));
  });

  it("handles rows in any order, empty input and non-numeric keys", () => {
    expect(collectLatestIo([])).toEqual([]);
    const older = new Date(Date.UTC(2026, 0, 1));
    const newer = new Date(Date.UTC(2026, 0, 2));
    const io = collectLatestIo([
      { ts: older, ioData: { "66": 1, junk: 5 } },
      { ts: newer, ioData: { "66": 2 } },
    ]);
    expect(io).toEqual([{ id: 66, value: 2, ts: newer }]);
  });
});

describe("/devices routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const as = (role: string, allowedArea: string | null = null) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("shows the sheet with the SIM only to owner/admin accounts that see the whole fleet", async () => {
    mocks.getDeviceDetail.mockResolvedValue({ device: { id: DEVICE_ID }, io: [] });
    const cases: Array<[string, string | null, boolean]> = [
      ["owner", null, true],
      ["admin", null, true],
      ["manager", null, false],
      ["viewer", null, false],
      ["admin", "DHL", false],
    ];
    for (const [role, area, includeSim] of cases) {
      mocks.getDeviceDetail.mockClear();
      const res = await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}`, headers: as(role, area) });
      expect(res.statusCode, `${role}/${area}`).toBe(200);
      expect(mocks.getDeviceDetail).toHaveBeenCalledWith("org-1", DEVICE_ID, { allowedArea: area, includeSim });
    }
  });

  it("answers 404 for a device that isn't visible and 400 for a malformed id", async () => {
    mocks.getDeviceDetail.mockResolvedValue(undefined);
    expect((await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}`, headers: as("owner") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/devices/not-a-uuid", headers: as("owner") })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/devices/${DEVICE_ID}` })).statusCode).toBe(401);
  });

  it("lets only owner/admin edit, and only with an org-wide account", async () => {
    mocks.updateDevice.mockResolvedValue({ id: DEVICE_ID });
    for (const role of ["viewer", "manager"]) {
      const res = await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as(role), payload: { model: "FMC003" } });
      expect(res.statusCode, role).toBe(403);
    }
    const limited = await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("admin", "DHL"), payload: { model: "FMC003" } });
    expect(limited.statusCode).toBe(403);
    expect(mocks.updateDevice).not.toHaveBeenCalled();

    const ok = await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("owner"), payload: { model: "FMC003" } });
    expect(ok.statusCode).toBe(200);
  });

  it("edits only what is sent and turns an empty string into a cleared field", async () => {
    mocks.updateDevice.mockResolvedValue({ id: DEVICE_ID });
    await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("owner"), payload: { serialNumber: "1164718028" } });
    expect(mocks.updateDevice).toHaveBeenLastCalledWith("org-1", DEVICE_ID, { serialNumber: "1164718028" });

    await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("owner"), payload: { firmware: "", model: " FMC003 " } });
    expect(mocks.updateDevice).toHaveBeenLastCalledWith("org-1", DEVICE_ID, { firmware: null, model: "FMC003" });
  });

  it("rejects an empty model and answers 404 when the device isn't theirs", async () => {
    const bad = await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("owner"), payload: { model: "  " } });
    expect(bad.statusCode).toBe(400);
    expect(mocks.updateDevice).not.toHaveBeenCalled();

    mocks.updateDevice.mockResolvedValue(undefined);
    const missing = await app.inject({ method: "PATCH", url: `/devices/${DEVICE_ID}`, headers: as("owner"), payload: { model: "FMC003" } });
    expect(missing.statusCode).toBe(404);
  });

  it("passes the chosen model when claiming, and still works with only the IMEI", async () => {
    mocks.claimDevice.mockResolvedValue({ id: DEVICE_ID });
    await app.inject({ method: "POST", url: "/devices/claim", headers: as("owner"), payload: { imei: "860848088107876", model: "FMC003" } });
    expect(mocks.claimDevice).toHaveBeenLastCalledWith("org-1", "860848088107876", "FMC003");
    await app.inject({ method: "POST", url: "/devices/claim", headers: as("owner"), payload: { imei: "860848088107876" } });
    expect(mocks.claimDevice).toHaveBeenLastCalledWith("org-1", "860848088107876", undefined);
  });

  it("rejects a 15-digit IMEI with a wrong check digit before touching the service", async () => {
    const res = await app.inject({ method: "POST", url: "/devices/claim", headers: as("owner"), payload: { imei: "860848088107877" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/IMEI inválido/);
    expect(mocks.claimDevice).not.toHaveBeenCalled();
  });

  it("is closed to API keys", async () => {
    const key = "osk_live_" + "0".repeat(48);
    for (const [method, url] of [
      ["GET", `/devices/${DEVICE_ID}`],
      ["PATCH", `/devices/${DEVICE_ID}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
