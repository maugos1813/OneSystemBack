import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSims: vi.fn(),
  createSim: vi.fn(),
  updateSim: vi.fn(),
  deleteSim: vi.fn(),
  getSimSecrets: vi.fn(),
}));

vi.mock("../../src/services/sim.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/sim.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const { normalizeIccid, normalizePhone, SimError, toSimView } = await import("../../src/services/sim.service.js");

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174000";
const SIM_ID = "223e4567-e89b-12d3-a456-426614174000";

describe("normalizeIccid", () => {
  it("accepts the ICCID as printed on a TIM card, with or without spaces and the letter suffix", () => {
    expect(normalizeIccid("8939010002782221067-K48H")).toBe("8939010002782221067-K48H");
    expect(normalizeIccid("8939010002782221067 K48H")).toBe("8939010002782221067-K48H");
    expect(normalizeIccid("8939 0100 0278 2221 067-k48h")).toBe("8939010002782221067-K48H");
    expect(normalizeIccid("8939010002782221067")).toBe("8939010002782221067");
  });

  it("rejects things that are not an ICCID", () => {
    for (const bad of ["", "12345", "8939010002782221067-", "abcdefghijklmnopqrs", "8939010002782221067-TOOLONGSUFFIX"]) {
      expect(normalizeIccid(bad), bad).toBeNull();
    }
  });
});

describe("normalizePhone", () => {
  it("strips separators and keeps a leading +", () => {
    expect(normalizePhone("+39 331 5326088")).toBe("+393315326088");
    expect(normalizePhone("331 5326088")).toBe("3315326088");
    expect(normalizePhone("(331) 532-6088")).toBe("3315326088");
  });

  it("rejects numbers that are too short, too long or not numeric", () => {
    for (const bad of ["12345", "abc", "+39 331 53260881234567", "331-xx-6088"]) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });
});

describe("toSimView", () => {
  it("never carries the PIN or PUK, only whether they are stored", () => {
    const now = new Date();
    const view = toSimView({
      sim: {
        id: SIM_ID,
        orgId: "org",
        deviceId: DEVICE_ID,
        operator: "TIM",
        iccid: "8939010002782221067-K48H",
        phoneNumber: "+393315326088",
        nmu: "785730",
        pin: "0000",
        puk: "12345678",
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
      imei: "353742379862535",
      model: "FMB204",
      vehicleId: "v1",
      vehicleName: "VAN-1",
      plate: "AB123CD",
    });

    expect(view.hasPin).toBe(true);
    expect(view.hasPuk).toBe(true);
    expect(JSON.stringify(view)).not.toContain("12345678");
    expect(Object.keys(view)).not.toContain("pin");
    expect(Object.keys(view)).not.toContain("puk");
    expect(Object.keys(view)).not.toContain("orgId");
    expect(view.vehicle).toEqual({ id: "v1", name: "VAN-1", plate: "AB123CD" });
  });

  it("marks a SIM with no device as in stock", () => {
    const now = new Date();
    const view = toSimView({
      sim: { id: SIM_ID, orgId: "org", deviceId: null, operator: "TIM", iccid: "8939010002782221067", phoneNumber: null, nmu: null, pin: null, puk: null, notes: null, createdAt: now, updatedAt: now },
      imei: null,
      model: null,
      vehicleId: null,
      vehicleName: null,
      plate: null,
    });
    expect(view.device).toBeNull();
    expect(view.vehicle).toBeNull();
    expect(view.hasPin).toBe(false);
  });
});

describe("/sims routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const tokenFor = (role: string, allowedArea: string | null = null) =>
    app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never);
  const as = (role: string, allowedArea: string | null = null) => ({ authorization: `Bearer ${tokenFor(role, allowedArea)}` });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listSims.mockResolvedValue([]);
  });

  it("is for owner and admin only", async () => {
    for (const role of ["viewer", "manager"]) {
      expect((await app.inject({ method: "GET", url: "/sims", headers: as(role) })).statusCode, role).toBe(403);
    }
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/sims", headers: as(role) })).statusCode, role).toBe(200);
    }
    expect(mocks.listSims).toHaveBeenCalledTimes(2);
  });

  it("is closed to an account limited to one área, and to anonymous callers", async () => {
    expect((await app.inject({ method: "GET", url: "/sims", headers: as("admin", "DHL") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/sims" })).statusCode).toBe(401);
  });

  it("is closed to API keys, even for reads", async () => {
    const key = "osk_live_" + "0".repeat(48);
    for (const [method, url] of [
      ["GET", "/sims"],
      ["GET", `/sims/${SIM_ID}/secrets`],
      ["POST", "/sims"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a SIM with the ICCID and phone number normalized", async () => {
    mocks.createSim.mockResolvedValue({ id: SIM_ID });
    const res = await app.inject({
      method: "POST",
      url: "/sims",
      headers: as("owner"),
      payload: { iccid: "8939 0100 0278 2221 067 K48H", phoneNumber: "+39 331 5326088", nmu: "785730", pin: "0000", puk: "12345678", deviceId: DEVICE_ID, notes: "" },
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.createSim).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ iccid: "8939010002782221067-K48H", phoneNumber: "+393315326088", pin: "0000", puk: "12345678", deviceId: DEVICE_ID, notes: null }),
    );
  });

  it("rejects invalid data with a clear message", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ iccid: "123" }, /ICCID inválido/],
      [{ iccid: "8939010002782221067-K48H", phoneNumber: "12" }, /teléfono inválido/],
      [{ iccid: "8939010002782221067-K48H", pin: "12" }, /PIN/],
      [{ iccid: "8939010002782221067-K48H", puk: "123" }, /PUK/],
    ];
    for (const [payload, message] of cases) {
      const res = await app.inject({ method: "POST", url: "/sims", headers: as("admin"), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toMatch(message);
    }
    expect(mocks.createSim).not.toHaveBeenCalled();
  });

  it("turns a conflict (duplicate ICCID / device already has a SIM) into a 409", async () => {
    mocks.createSim.mockRejectedValue(new SimError(409, "A SIM with that ICCID is already registered"));
    const res = await app.inject({ method: "POST", url: "/sims", headers: as("owner"), payload: { iccid: "8939010002782221067" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already registered/);
  });

  it("edits only what is sent, and never touches PIN/PUK unless they are sent", async () => {
    mocks.updateSim.mockResolvedValue({ id: SIM_ID });
    const res = await app.inject({ method: "PATCH", url: `/sims/${SIM_ID}`, headers: as("owner"), payload: { notes: "Recargar el 5" } });
    expect(res.statusCode).toBe(200);
    const patch = mocks.updateSim.mock.calls[0]![2];
    expect(patch).toEqual({ notes: "Recargar el 5" });
    expect("pin" in patch).toBe(false);
    expect("puk" in patch).toBe(false);
  });

  it("answers 404 for an unknown SIM", async () => {
    mocks.updateSim.mockRejectedValue(new SimError(404, "SIM not found"));
    expect((await app.inject({ method: "PATCH", url: `/sims/${SIM_ID}`, headers: as("owner"), payload: { notes: "x" } })).statusCode).toBe(404);
    mocks.deleteSim.mockResolvedValue(false);
    expect((await app.inject({ method: "DELETE", url: `/sims/${SIM_ID}`, headers: as("owner") })).statusCode).toBe(404);
  });

  it("serves the PIN and PUK only from the secrets endpoint, never cacheable", async () => {
    mocks.getSimSecrets.mockResolvedValue({ pin: "0000", puk: "12345678" });
    const res = await app.inject({ method: "GET", url: `/sims/${SIM_ID}/secrets`, headers: as("owner") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pin: "0000", puk: "12345678" });
    expect(res.headers["cache-control"]).toBe("no-store");

    expect((await app.inject({ method: "GET", url: `/sims/${SIM_ID}/secrets`, headers: as("viewer") })).statusCode).toBe(403);
    mocks.getSimSecrets.mockResolvedValue(undefined);
    expect((await app.inject({ method: "GET", url: `/sims/${SIM_ID}/secrets`, headers: as("owner") })).statusCode).toBe(404);
  });

  it("is not part of the public /v1 API document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).some((p) => p.includes("sim"))).toBe(false);
  });
});
