import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMaintenance: vi.fn(),
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  deletePlan: vi.fn(),
  listRecords: vi.fn(),
  registerService: vi.fn(),
  calibrateOdometer: vi.fn(),
}));

vi.mock("../../src/services/maintenance.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/maintenance.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const { MaintenanceError } = await import("../../src/services/maintenance.service.js");

const VEHICLE = "123e4567-e89b-12d3-a456-426614174000";
const PLAN = "223e4567-e89b-12d3-a456-426614174000";

describe("/maintenance routes", () => {
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
    mocks.listMaintenance.mockResolvedValue([]);
  });

  it("everyone logged in can read, scoped to their área", async () => {
    for (const role of ["viewer", "manager", "admin", "owner"]) {
      expect((await app.inject({ method: "GET", url: "/maintenance", headers: as(role) })).statusCode, role).toBe(200);
    }
    await app.inject({ method: "GET", url: "/maintenance", headers: as("viewer", "DHL") });
    expect(mocks.listMaintenance).toHaveBeenLastCalledWith("org-1", "DHL");
    expect((await app.inject({ method: "GET", url: "/maintenance" })).statusCode).toBe(401);
  });

  it("only owner, admin and manager can write", async () => {
    mocks.createPlan.mockResolvedValue({ id: PLAN });
    mocks.registerService.mockResolvedValue({ id: PLAN });
    mocks.updatePlan.mockResolvedValue({ id: PLAN });
    mocks.calibrateOdometer.mockResolvedValue({});
    const writes = [
      { method: "POST", url: "/maintenance/plans", payload: { vehicleId: VEHICLE, name: "Aceite", intervalKm: 15000 } },
      { method: "PATCH", url: `/maintenance/plans/${PLAN}`, payload: { name: "x" } },
      { method: "DELETE", url: `/maintenance/plans/${PLAN}`, payload: undefined },
      { method: "POST", url: `/maintenance/plans/${PLAN}/records`, payload: {} },
      { method: "PUT", url: `/maintenance/vehicles/${VEHICLE}/odometer`, payload: { dashboardKm: 85000 } },
    ] as const;
    for (const write of writes) {
      const denied = await app.inject({ ...write, headers: as("viewer") });
      expect(denied.statusCode, `viewer ${write.method} ${write.url}`).toBe(403);
      for (const role of ["manager", "admin", "owner"]) {
        const ok = await app.inject({ ...write, headers: as(role) });
        expect(ok.statusCode, `${role} ${write.method} ${write.url}`).toBeLessThan(300);
      }
    }
  });

  it("is closed to API keys", async () => {
    const key = "osk_live_" + "0".repeat(48);
    for (const [method, url] of [
      ["GET", "/maintenance"],
      ["POST", "/maintenance/plans"],
      ["DELETE", `/maintenance/plans/${PLAN}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a plan passing the área and only what was sent", async () => {
    mocks.createPlan.mockResolvedValue({ id: PLAN });
    const res = await app.inject({
      method: "POST",
      url: "/maintenance/plans",
      headers: as("manager", "DHL"),
      payload: { vehicleId: VEHICLE, name: " Aceite ", intervalKm: 15000, intervalMonths: 12, notes: "", lastDoneAt: "2026-09-01" },
    });
    expect(res.statusCode).toBe(201);
    const [orgId, area, vehicleId, input] = mocks.createPlan.mock.calls[0]!;
    expect([orgId, area, vehicleId]).toEqual(["org-1", "DHL", VEHICLE]);
    expect(input).toMatchObject({ name: "Aceite", intervalKm: 15000, intervalMonths: 12, notes: null });
    expect(input.lastDoneAt).toEqual(new Date("2026-09-01"));
    expect("lastDoneKm" in input).toBe(false);
  });

  it("rejects bad input with 400 before reaching the service", async () => {
    const bad: Array<Record<string, unknown>> = [
      { vehicleId: "nope", name: "x", intervalKm: 1 },
      { vehicleId: VEHICLE, name: "  ", intervalKm: 1 },
      { vehicleId: VEHICLE, name: "x", intervalKm: -5 },
      { vehicleId: VEHICLE, name: "x", intervalKm: 1.5 },
      { vehicleId: VEHICLE, name: "x", intervalMonths: 1000 },
      { vehicleId: VEHICLE, name: "x", intervalKm: 100, lastDoneAt: "not a date" },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/maintenance/plans", headers: as("owner"), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(mocks.createPlan).not.toHaveBeenCalled();
    expect((await app.inject({ method: "PATCH", url: "/maintenance/plans/xyz", headers: as("owner"), payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: `/maintenance/vehicles/${VEHICLE}/odometer`, headers: as("owner"), payload: { dashboardKm: -1 } })).statusCode,
    ).toBe(400);
  });

  it("turns the service's errors into 404 and 400", async () => {
    mocks.createPlan.mockRejectedValue(new MaintenanceError(404, "Vehicle not found"));
    const notFound = await app.inject({ method: "POST", url: "/maintenance/plans", headers: as("owner"), payload: { vehicleId: VEHICLE, name: "x", intervalKm: 5 } });
    expect(notFound.statusCode).toBe(404);

    mocks.registerService.mockRejectedValue(new MaintenanceError(400, "La fecha del servicio no puede ser futura"));
    const bad = await app.inject({ method: "POST", url: `/maintenance/plans/${PLAN}/records`, headers: as("owner"), payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/futura/);
  });

  it("registers a service with a date and notes, and lists the history", async () => {
    mocks.registerService.mockResolvedValue({ id: PLAN });
    mocks.listRecords.mockResolvedValue([{ id: "r1" }]);
    const res = await app.inject({
      method: "POST",
      url: `/maintenance/plans/${PLAN}/records`,
      headers: as("admin"),
      payload: { doneAt: "2026-10-01T10:00:00Z", odometerKm: 84500, notes: "Olio" },
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.registerService).toHaveBeenCalledWith("org-1", null, PLAN, { doneAt: new Date("2026-10-01T10:00:00Z"), odometerKm: 84500, notes: "Olio" });

    const history = await app.inject({ method: "GET", url: `/maintenance/plans/${PLAN}/records`, headers: as("viewer") });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([{ id: "r1" }]);
  });

  it("calibrates the odometer with the dashboard reading", async () => {
    mocks.calibrateOdometer.mockResolvedValue({ trackerKm: 8000, offsetKm: 77000, odometerKm: 85000 });
    const res = await app.inject({ method: "PUT", url: `/maintenance/vehicles/${VEHICLE}/odometer`, headers: as("manager"), payload: { dashboardKm: 85000 } });
    expect(res.statusCode).toBe(200);
    expect(mocks.calibrateOdometer).toHaveBeenCalledWith("org-1", null, VEHICLE, 85000);
    expect(res.json()).toEqual({ trackerKm: 8000, offsetKm: 77000, odometerKm: 85000 });
  });
});
