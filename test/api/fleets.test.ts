import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listFleetPictures: vi.fn(), setFleetLogo: vi.fn(), setFleetVehicles: vi.fn() }));
class FleetVehiclesError extends Error {}
vi.mock("../../src/services/fleet.service.js", () => ({ ...mocks, FleetVehiclesError }));

const { buildApp } = await import("../../src/api/app.js");

describe("the fleets the map draws", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listFleetPictures.mockResolvedValue([{ name: "ONE DRIVER EXPRESS", tag: null }]);
  });
  const as = (role: string, allowedArea: string | null = null) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });

  it("gives every user the pictures of their fleets, within their own fleet if limited to one", async () => {
    for (const role of ["viewer", "manager", "admin", "owner"]) {
      expect((await app.inject({ method: "GET", url: "/fleets", headers: as(role) })).statusCode, role).toBe(200);
    }
    await app.inject({ method: "GET", url: "/fleets", headers: as("viewer", "ONE DRIVER EXPRESS") });
    expect(mocks.listFleetPictures).toHaveBeenLastCalledWith("org-1", "ONE DRIVER EXPRESS");
    expect((await app.inject({ method: "GET", url: "/fleets" })).statusCode).toBe(401);
  });

  it("lets only owner and admin of the whole organization choose a fleet's vehicles", async () => {
    mocks.setFleetVehicles.mockResolvedValue({ inFleet: 1, released: 0 });
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const body = { fleet: "ONE DRIVER EXPRESS", vehicleIds: [id] };
    for (const [role, area] of [["viewer", null], ["manager", null], ["admin", "ONE DRIVER EXPRESS"]] as const) {
      expect((await app.inject({ method: "PUT", url: "/fleets/vehicles", headers: as(role, area), payload: body })).statusCode, `${role}/${area}`).toBe(403);
    }
    expect(mocks.setFleetVehicles).not.toHaveBeenCalled();
    const ok = await app.inject({ method: "PUT", url: "/fleets/vehicles", headers: as("owner"), payload: body });
    expect(ok.statusCode).toBe(200);
    expect(mocks.setFleetVehicles).toHaveBeenCalledWith("org-1", "ONE DRIVER EXPRESS", [id]);
  });

  it("rejects a bad body and relays a vehicle that is not theirs as 400", async () => {
    const headers = as("owner");
    expect((await app.inject({ method: "PUT", url: "/fleets/vehicles", headers, payload: { fleet: "", vehicleIds: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/fleets/vehicles", headers, payload: { fleet: "X", vehicleIds: ["nope"] } })).statusCode).toBe(400);
    mocks.setFleetVehicles.mockRejectedValue(new FleetVehiclesError("Algún vehículo no existe en esta cuenta"));
    const res = await app.inject({ method: "PUT", url: "/fleets/vehicles", headers, payload: { fleet: "X", vehicleIds: ["123e4567-e89b-12d3-a456-426614174000"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no existe/);
  });

  it("no longer has routes to manage fleets apart from the team", async () => {
    for (const [method, url] of [["GET", "/fleets/manage"], ["PUT", "/fleets/logo"], ["POST", "/fleets/admin"]] as const) {
      expect((await app.inject({ method, url, headers: as("owner"), payload: {} })).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
