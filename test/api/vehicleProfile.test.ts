import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getVehicleProfile: vi.fn(),
  listVehicleOdometers: vi.fn(),
  setVehicleOdometer: vi.fn(),
  updateVehicle: vi.fn(),
  getVehicleForOrg: vi.fn(),
}));

const granted = vi.hoisted(() => ({ modules: [] as string[] }));
vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => granted.modules }));
vi.mock("../../src/services/vehicleProfile.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicleProfile.service.js")>()),
  getVehicleProfile: mocks.getVehicleProfile,
  listVehicleOdometers: mocks.listVehicleOdometers,
  setVehicleOdometer: mocks.setVehicleOdometer,
}));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  updateVehicle: mocks.updateVehicle,
  getVehicleForOrg: mocks.getVehicleForOrg,
}));

const { buildApp } = await import("../../src/api/app.js");
const { ProfileError } = await import("../../src/services/vehicleProfile.service.js");

const VEHICLE = "123e4567-e89b-12d3-a456-426614174000";

describe("vehicle profile routes", () => {
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
    granted.modules = [];
  });

  it("serves the profile and the list of km to anyone who can see the vehicles, scoped to their área", async () => {
    mocks.getVehicleProfile.mockResolvedValue({ vehicle: { id: VEHICLE }, odometer: { km: 1 } });
    mocks.listVehicleOdometers.mockResolvedValue([]);
    const profile = await app.inject({ method: "GET", url: `/vehicles/${VEHICLE}/profile`, headers: as("viewer", "DHL") });
    expect(profile.statusCode).toBe(200);
    expect(mocks.getVehicleProfile).toHaveBeenCalledWith("org-1", "DHL", VEHICLE);
    const list = await app.inject({ method: "GET", url: "/vehicles/odometers", headers: as("viewer", "DHL") });
    expect(list.statusCode).toBe(200);
    expect(mocks.listVehicleOdometers).toHaveBeenCalledWith("org-1", "DHL");
  });

  it("a vehicle that is not theirs is a 404", async () => {
    mocks.getVehicleProfile.mockRejectedValue(new ProfileError(404, "Vehicle not found"));
    expect((await app.inject({ method: "GET", url: `/vehicles/${VEHICLE}/profile`, headers: as("viewer") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/vehicles/not-a-uuid/profile", headers: as("viewer") })).statusCode).toBe(400);
  });

  it("only owner, admin and manager set the km; a client only with the Vehículos section and a flota", async () => {
    mocks.setVehicleOdometer.mockResolvedValue({ km: 5 });
    const put = (headers: Record<string, string>) =>
      app.inject({ method: "PUT", url: `/vehicles/${VEHICLE}/odometer`, headers, payload: { mode: "auto", km: 5 } });
    for (const role of ["owner", "admin", "manager"]) expect((await put(as(role))).statusCode, role).toBe(200);
    expect((await put(as("viewer"))).statusCode).toBe(403);
    expect((await put(as("viewer", "DHL"))).statusCode).toBe(403);
    granted.modules = ["vehiculos"];
    expect((await put(as("viewer", "DHL"))).statusCode).toBe(200);
  });

  it("checks what it is given: a mode, and a km that makes sense", async () => {
    const put = (payload: unknown) =>
      app.inject({ method: "PUT", url: `/vehicles/${VEHICLE}/odometer`, headers: as("admin"), payload: payload as never });
    expect((await put({ mode: "sometimes" })).statusCode).toBe(400);
    expect((await put({ mode: "manual", km: -3 })).statusCode).toBe(400);
    expect((await put({ mode: "manual", km: 1.5 })).statusCode).toBe(400);
    expect(mocks.setVehicleOdometer).not.toHaveBeenCalled();
    mocks.setVehicleOdometer.mockRejectedValue(new ProfileError(400, "Indica el kilometraje actual"));
    expect((await put({ mode: "manual" })).statusCode).toBe(400);
  });

  it("edits the profile data with the vehicle's own PATCH, and rejects an unknown fuel", async () => {
    mocks.updateVehicle.mockResolvedValue({ id: VEHICLE });
    const patch = (payload: unknown) =>
      app.inject({ method: "PATCH", url: `/vehicles/${VEHICLE}`, headers: as("admin"), payload: payload as never });
    expect((await patch({ brand: "Iveco", model: "Daily", year: 2021, vin: "ZCFC35A0005", fuelType: "diesel", color: "Bianco", notes: " " })).statusCode).toBe(200);
    expect(mocks.updateVehicle).toHaveBeenCalledWith("org-1", VEHICLE, expect.objectContaining({ brand: "Iveco", year: 2021, fuelType: "diesel", notes: null }));
    expect((await patch({ fuelType: "water" })).statusCode).toBe(400);
    expect((await patch({ year: 1800 })).statusCode).toBe(400);
  });
});
