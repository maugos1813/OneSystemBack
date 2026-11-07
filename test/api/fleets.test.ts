import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listFleetDetails: vi.fn(),
  listFleetPictures: vi.fn(),
  setFleetLogo: vi.fn(),
  createFleetAdmin: vi.fn(),
}));
vi.mock("../../src/services/fleet.service.js", () => mocks);

const { buildApp } = await import("../../src/api/app.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("fleets of the client's own organization", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listFleetPictures.mockResolvedValue([]);
    mocks.listFleetDetails.mockResolvedValue([]);
  });
  const as = (role: string, allowedArea: string | null = null) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });

  it("gives every user the pictures of their fleets, within their own fleet if limited to one", async () => {
    for (const role of ["viewer", "manager", "admin", "owner"]) {
      expect((await app.inject({ method: "GET", url: "/fleets", headers: as(role) })).statusCode, role).toBe(200);
    }
    await app.inject({ method: "GET", url: "/fleets", headers: as("viewer", "DHL") });
    expect(mocks.listFleetPictures).toHaveBeenLastCalledWith("org-1", "DHL");
    expect((await app.inject({ method: "GET", url: "/fleets" })).statusCode).toBe(401);
  });

  it("lets only owner and admin of the whole organization manage the fleets", async () => {
    mocks.setFleetLogo.mockResolvedValue({ name: "DHL", logo: PNG });
    for (const [role, area] of [["viewer", null], ["manager", null], ["admin", "DHL"]] as const) {
      expect((await app.inject({ method: "GET", url: "/fleets/manage", headers: as(role, area) })).statusCode, `${role}/${area}`).toBe(403);
      expect((await app.inject({ method: "PUT", url: "/fleets/logo", headers: as(role, area), payload: { name: "DHL", logo: PNG } })).statusCode).toBe(403);
    }
    expect(mocks.setFleetLogo).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/fleets/manage", headers: as("admin") })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/fleets/logo", headers: as("owner"), payload: { name: "DHL", logo: PNG } })).statusCode).toBe(200);
    expect(mocks.setFleetLogo).toHaveBeenCalledWith("org-1", "DHL", PNG, null);
    await app.inject({ method: "PUT", url: "/fleets/logo", headers: as("owner"), payload: { name: "DHL", logo: PNG, tag: PNG } });
    expect(mocks.setFleetLogo).toHaveBeenLastCalledWith("org-1", "DHL", PNG, PNG);
    await app.inject({ method: "PUT", url: "/fleets/logo", headers: as("owner"), payload: { name: "DHL", logo: null, tag: PNG } });
    expect(mocks.setFleetLogo).toHaveBeenLastCalledWith("org-1", "DHL", null, null);
  });

  it("rejects a bad image or an empty fleet name", async () => {
    const bad = await app.inject({ method: "PUT", url: "/fleets/logo", headers: as("owner"), payload: { name: "DHL", logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
    const empty = await app.inject({ method: "PUT", url: "/fleets/logo", headers: as("owner"), payload: { name: "  ", logo: null } });
    expect(bad.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(mocks.setFleetLogo).not.toHaveBeenCalled();
  });

  it("creates the administrator account of a fleet, and answers 409 for an email already in use", async () => {
    mocks.createFleetAdmin.mockResolvedValue({ id: "new" });
    const body = { fleet: "UNIVEX", name: "Ana", email: "ana@x.it", password: "12345678" };
    expect((await app.inject({ method: "POST", url: "/fleets/admin", headers: as("viewer"), payload: body })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/fleets/admin", headers: as("owner"), payload: body });
    expect(ok.statusCode).toBe(201);
    expect(mocks.createFleetAdmin).toHaveBeenCalledWith("org-1", "UNIVEX", { name: "Ana", email: "ana@x.it", password: "12345678" });
    mocks.createFleetAdmin.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    expect((await app.inject({ method: "POST", url: "/fleets/admin", headers: as("owner"), payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/fleets/admin", headers: as("owner"), payload: { ...body, password: "short" } })).statusCode).toBe(400);
  });
});
