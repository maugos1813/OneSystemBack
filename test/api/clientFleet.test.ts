import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A client (viewer/manager with a flota) managing their own vehicles and documents — and nothing beyond them. */

const state = vi.hoisted(() => ({ granted: [] as string[] }));
const mocks = vi.hoisted(() => ({
  createVehicle: vi.fn(),
  updateVehicle: vi.fn(),
  deleteVehicle: vi.fn(),
  getVehicleForOrg: vi.fn(),
  listVehicleDocuments: vi.fn(),
  createDocument: vi.fn(),
}));

vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => state.granted }));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  createVehicle: mocks.createVehicle,
  updateVehicle: mocks.updateVehicle,
  deleteVehicle: mocks.deleteVehicle,
  getVehicleForOrg: mocks.getVehicleForOrg,
}));
vi.mock("../../src/services/vehicleDocument.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicleDocument.service.js")>()),
  listVehicleDocuments: mocks.listVehicleDocuments,
  createDocument: mocks.createDocument,
}));

const { buildApp } = await import("../../src/api/app.js");

const VEHICLE = "123e4567-e89b-12d3-a456-426614174000";

describe("a client's own fleet", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    state.granted = ["mapa", "vehiculos", "vencimientos"];
    mocks.createVehicle.mockImplementation(async (input: object) => ({ id: "v1", ...input }));
    mocks.updateVehicle.mockResolvedValue({ id: VEHICLE });
    mocks.deleteVehicle.mockResolvedValue(true);
    mocks.getVehicleForOrg.mockResolvedValue({ id: VEHICLE });
    mocks.listVehicleDocuments.mockResolvedValue([]);
  });

  const as = (role: string, allowedArea: string | null = "PIAZZA") => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });

  describe("vehicles", () => {
    it("lets a client create a vehicle, always inside their own flota", async () => {
      const res = await app.inject({ method: "POST", url: "/vehicles", headers: as("viewer"), payload: { name: "Furgone", plate: "PZ111AA" } });
      expect(res.statusCode).toBe(201);
      expect(mocks.createVehicle).toHaveBeenCalledWith(expect.objectContaining({ name: "Furgone", fleetGroup: "PIAZZA", orgId: "org-1" }));
    });

    it("refuses a device, or another flota, from a client", async () => {
      const device = await app.inject({ method: "POST", url: "/vehicles", headers: as("viewer"), payload: { name: "x", deviceId: VEHICLE } });
      const other = await app.inject({ method: "POST", url: "/vehicles", headers: as("viewer"), payload: { name: "x", fleetGroup: "DHL" } });
      expect([device.statusCode, other.statusCode]).toEqual([403, 403]);
      expect(mocks.createVehicle).not.toHaveBeenCalled();
    });

    it("needs both the Vehículos section and a flota", async () => {
      state.granted = ["mapa"];
      expect((await app.inject({ method: "POST", url: "/vehicles", headers: as("viewer"), payload: { name: "x" } })).statusCode).toBe(403);
      state.granted = ["mapa", "vehiculos"];
      expect((await app.inject({ method: "POST", url: "/vehicles", headers: as("viewer", null), payload: { name: "x" } })).statusCode).toBe(403);
      expect(mocks.createVehicle).not.toHaveBeenCalled();
    });

    it("lets a client rename and delete only vehicles of their own flota, and never move them", async () => {
      const url = `/vehicles/${VEHICLE}`;
      expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { name: "Nuevo" } })).statusCode).toBe(200);
      expect(mocks.getVehicleForOrg).toHaveBeenLastCalledWith("org-1", VEHICLE, "PIAZZA");

      expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { fleetGroup: "DHL" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { deviceId: VEHICLE } })).statusCode).toBe(403);

      mocks.getVehicleForOrg.mockResolvedValue(undefined); // not in their flota
      expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { name: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url, headers: as("manager") })).statusCode).toBe(404);
      expect(mocks.updateVehicle).toHaveBeenCalledTimes(1);
      expect(mocks.deleteVehicle).not.toHaveBeenCalled();
    });

    it("keeps owner and admin as they were: any flota, any device", async () => {
      const res = await app.inject({ method: "POST", url: "/vehicles", headers: as("admin", null), payload: { name: "x", fleetGroup: "DHL", deviceId: VEHICLE } });
      expect(res.statusCode).toBe(201);
      expect(mocks.createVehicle).toHaveBeenCalledWith(expect.objectContaining({ fleetGroup: "DHL", deviceId: VEHICLE }));
    });
  });

  describe("documents (vencimientos)", () => {
    const doc = { kind: "seguro", expiresOn: "2027-01-01" };

    it("is closed to a client whose account doesn't include the section", async () => {
      state.granted = ["mapa", "vehiculos"];
      expect((await app.inject({ method: "GET", url: "/vehicle-documents", headers: as("viewer") })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/vehicles/${VEHICLE}/documents`, headers: as("viewer"), payload: doc })).statusCode).toBe(403);
      expect(mocks.createDocument).not.toHaveBeenCalled();
    });

    it("lists and creates for a client with the section, scoped to their flota", async () => {
      mocks.createDocument.mockResolvedValue({ id: "d1" });
      expect((await app.inject({ method: "GET", url: "/vehicle-documents", headers: as("viewer") })).statusCode).toBe(200);
      expect(mocks.listVehicleDocuments).toHaveBeenCalledWith("org-1", "PIAZZA");
      expect((await app.inject({ method: "POST", url: `/vehicles/${VEHICLE}/documents`, headers: as("viewer"), payload: doc })).statusCode).toBe(201);
      expect(mocks.createDocument).toHaveBeenCalledWith("org-1", "PIAZZA", VEHICLE, expect.objectContaining(doc));
    });

    it("rejects a bad date or kind", async () => {
      const url = `/vehicles/${VEHICLE}/documents`;
      for (const payload of [{ kind: "seguro", expiresOn: "mañana" }, { kind: "seguro", expiresOn: "2027-13-45" }, { kind: "pasaporte", expiresOn: "2027-01-01" }]) {
        expect((await app.inject({ method: "POST", url, headers: as("viewer"), payload })).statusCode).toBe(400);
      }
    });

    it("answers 404 for a vehicle that is not theirs", async () => {
      const { DocumentError } = await import("../../src/services/vehicleDocument.service.js");
      mocks.createDocument.mockRejectedValue(new DocumentError(404, "Vehicle not found"));
      expect((await app.inject({ method: "POST", url: `/vehicles/${VEHICLE}/documents`, headers: as("viewer"), payload: doc })).statusCode).toBe(404);
    });

    it("is open to owner and admin without being granted anything", async () => {
      state.granted = [];
      expect((await app.inject({ method: "GET", url: "/vehicle-documents", headers: as("owner", null) })).statusCode).toBe(200);
    });
  });
});
