import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAME_ORG = "11111111-1111-4111-8111-111111111111";
const CLIENT_ORG = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  isPlatformUser: vi.fn(async (id: string) => id === "platform-user"),
  listOrganizations: vi.fn(),
  createClientOrganization: vi.fn(),
  getOrganizationDetail: vi.fn(),
  getOrganizationBrief: vi.fn(),
  getPlatformFleet: vi.fn(),
  setUserLogo: vi.fn(),
  setOrganizationSections: vi.fn(),
  setOrganizationLogo: vi.fn(),
}));
const fleetMocks = vi.hoisted(() => ({ listFleetDetails: vi.fn(), listFleetPictures: vi.fn(), setFleetLogo: vi.fn(), createFleetAdmin: vi.fn() }));
vi.mock("../../src/services/fleet.service.js", () => fleetMocks);

vi.mock("../../src/services/platform.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platform.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");

describe("cross-client administration is for one account alone", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const [name, mock] of Object.entries(mocks)) if (name !== "isPlatformUser") mock.mockReset();
    mocks.listOrganizations.mockResolvedValue([]);
  });

  const as = (orgId: string, role: string, userId = "u1") => ({
    authorization: `Bearer ${app.jwt.sign({ userId, orgId, role, allowedArea: null } as never)}`,
  });
  const body = { orgName: "Cliente Nuevo", email: "nuevo@cliente.it", password: "12345678" };

  it("refuses anyone else on every platform route, even an owner/admin in the very same organization", async () => {
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(SAME_ORG, role) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/platform/organizations", headers: as(SAME_ORG, role), payload: body })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(SAME_ORG, role) })).statusCode).toBe(403);
    }
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
    expect(mocks.createClientOrganization).not.toHaveBeenCalled();
  });

  it("refuses an API key and a lower role even for the listed account", async () => {
    for (const role of ["manager", "viewer"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(SAME_ORG, role, "platform-user") })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(SAME_ORG, "admin", "api-key") })).statusCode).toBe(403);
  });

  it("refuses unauthenticated requests", async () => {
    expect((await app.inject({ method: "GET", url: "/platform/organizations" })).statusCode).toBe(401);
  });

  it("lets the listed account list, read and create clients", async () => {
    mocks.createClientOrganization.mockResolvedValue({ orgId: CLIENT_ORG, user: { id: "u9" } });
    mocks.getOrganizationDetail.mockResolvedValue({ id: CLIENT_ORG });
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(SAME_ORG, role, "platform-user") })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(SAME_ORG, role, "platform-user") })).statusCode).toBe(200);
      const created = await app.inject({ method: "POST", url: "/platform/organizations", headers: as(SAME_ORG, role, "platform-user"), payload: body });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ orgId: CLIENT_ORG, userId: "u9" });
    }
  });

  it("returns 404 for an unknown client and 400 for a malformed id", async () => {
    mocks.getOrganizationDetail.mockResolvedValue(undefined);
    expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(SAME_ORG, "owner", "platform-user") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/platform/organizations/nope", headers: as(SAME_ORG, "owner", "platform-user") })).statusCode).toBe(400);
  });

  describe("looking at a client's account (view-only)", () => {
    it("gives OneSystec, and only OneSystec, a read-only token that carries the client's organization", async () => {
      mocks.getOrganizationBrief.mockResolvedValue({ id: CLIENT_ORG, name: "Cliente", logo: null });
      const url = `/platform/organizations/${CLIENT_ORG}/view`;
      expect((await app.inject({ method: "POST", url, headers: as(SAME_ORG, "admin", "u1") })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);

      const ok = await app.inject({ method: "POST", url, headers: as(SAME_ORG, "admin", "platform-user") });
      expect(ok.statusCode).toBe(200);
      const claims = app.jwt.decode<{ userId: string; orgId: string; role: string; viewAs?: boolean; exp?: number }>(ok.json().token)!;
      expect(claims).toMatchObject({ userId: "platform-user", orgId: CLIENT_ORG, role: "admin", viewAs: true });
      expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    });

    it("answers 404 for an unknown client", async () => {
      mocks.getOrganizationBrief.mockResolvedValue(undefined);
      const res = await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT_ORG}/view`, headers: as(SAME_ORG, "admin", "platform-user") });
      expect(res.statusCode).toBe(404);
    });

    const viewToken = () => ({
      authorization: `Bearer ${app.jwt.sign({ userId: "platform-user", orgId: CLIENT_ORG, role: "admin", allowedArea: null, viewAs: true } as never)}`,
    });

    it("lets that token read but refuses every change, API keys included", async () => {
      expect((await app.inject({ method: "GET", url: "/devices", headers: viewToken() })).statusCode).not.toBe(403);
      for (const [method, url] of [
        ["POST", "/geofences"],
        ["PATCH", `/devices/${CLIENT_ORG}`],
        ["DELETE", `/vehicles/${CLIENT_ORG}`],
        ["POST", "/api-keys"],
        ["POST", "/users"],
      ] as const) {
        const res = await app.inject({ method, url, headers: viewToken(), payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it("stops working the moment its holder is no longer OneSystec", async () => {
      mocks.isPlatformUser.mockResolvedValueOnce(false);
      expect((await app.inject({ method: "GET", url: "/devices", headers: viewToken() })).statusCode).toBe(403);
    });
  });

  describe("the all-clients map", () => {
    it("gives the fleet of every client to OneSystec only", async () => {
      mocks.getPlatformFleet.mockResolvedValue({ vehicles: [], devices: [], positions: {} });
      expect((await app.inject({ method: "GET", url: "/platform/fleet", headers: as(SAME_ORG, "admin", "u1") })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/platform/fleet" })).statusCode).toBe(401);
      expect(mocks.getPlatformFleet).not.toHaveBeenCalled();
      const ok = await app.inject({ method: "GET", url: "/platform/fleet", headers: as(SAME_ORG, "admin", "platform-user") });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ vehicles: [], devices: [], positions: {} });
    });

    it("is not available through a view-only token on one client", async () => {
      const token = app.jwt.sign({ userId: "platform-user", orgId: CLIENT_ORG, role: "admin", allowedArea: null, viewAs: true } as never);
      const res = await app.inject({ method: "GET", url: "/platform/fleet", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("the photo of a client's user", () => {
    const USER = "423e4567-e89b-12d3-a456-426614174000";
    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    it("is set by OneSystec for any user, and by nobody else", async () => {
      mocks.setUserLogo.mockResolvedValue({ id: USER, logo: PNG });
      const url = `/platform/users/${USER}/logo`;
      expect((await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "owner", "u1"), payload: { logo: PNG } })).statusCode).toBe(403);
      expect(mocks.setUserLogo).not.toHaveBeenCalled();
      const ok = await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "admin", "platform-user"), payload: { logo: PNG } });
      expect(ok.statusCode).toBe(200);
      expect(mocks.setUserLogo).toHaveBeenCalledWith(USER, PNG);
      const cleared = await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "admin", "platform-user"), payload: { logo: null } });
      expect(cleared.statusCode).toBe(200);
      expect(mocks.setUserLogo).toHaveBeenLastCalledWith(USER, null);
    });

    it("rejects a bad image or id, and answers 404 for an unknown user", async () => {
      const headers = as(SAME_ORG, "admin", "platform-user");
      const bad = await app.inject({ method: "PATCH", url: `/platform/users/${USER}/logo`, headers, payload: { logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/platform/users/nope/logo", headers, payload: { logo: null } })).statusCode).toBe(400);
      mocks.setUserLogo.mockResolvedValue(undefined);
      expect((await app.inject({ method: "PATCH", url: `/platform/users/${USER}/logo`, headers, payload: { logo: null } })).statusCode).toBe(404);
    });
  });

  describe("what a client may have", () => {
    it("is decided by OneSystec alone", async () => {
      mocks.setOrganizationSections.mockResolvedValue({ sections: ["mapa"] });
      const url = `/platform/organizations/${CLIENT_ORG}/sections`;
      expect((await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "owner", "u1"), payload: { sections: ["mapa"] } })).statusCode).toBe(403);
      expect(mocks.setOrganizationSections).not.toHaveBeenCalled();
      const ok = await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "admin", "platform-user"), payload: { sections: ["mapa"] } });
      expect(ok.statusCode).toBe(200);
      expect(mocks.setOrganizationSections).toHaveBeenCalledWith(CLIENT_ORG, ["mapa"]);
      await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "admin", "platform-user"), payload: { sections: null } });
      expect(mocks.setOrganizationSections).toHaveBeenLastCalledWith(CLIENT_ORG, null);
    });

    it("rejects a malformed body or id, and answers 404 for an unknown client", async () => {
      const headers = as(SAME_ORG, "admin", "platform-user");
      expect((await app.inject({ method: "PATCH", url: `/platform/organizations/${CLIENT_ORG}/sections`, headers, payload: { sections: "mapa" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/platform/organizations/nope/sections", headers, payload: { sections: null } })).statusCode).toBe(400);
      mocks.setOrganizationSections.mockResolvedValue(undefined);
      expect((await app.inject({ method: "PATCH", url: `/platform/organizations/${CLIENT_ORG}/sections`, headers, payload: { sections: [] } })).statusCode).toBe(404);
    });
  });

  describe("the company logo of a client", () => {
    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const url = `/platform/organizations/${CLIENT_ORG}/logo`;

    it("is set or removed by OneSystec alone", async () => {
      mocks.setOrganizationLogo.mockResolvedValue({ id: CLIENT_ORG, logo: PNG });
      expect((await app.inject({ method: "PATCH", url, headers: as(SAME_ORG, "owner", "u1"), payload: { logo: PNG } })).statusCode).toBe(403);
      expect(mocks.setOrganizationLogo).not.toHaveBeenCalled();
      const headers = as(SAME_ORG, "admin", "platform-user");
      expect((await app.inject({ method: "PATCH", url, headers, payload: { logo: PNG } })).statusCode).toBe(200);
      expect(mocks.setOrganizationLogo).toHaveBeenLastCalledWith(CLIENT_ORG, PNG);
      await app.inject({ method: "PATCH", url, headers, payload: { logo: null } });
      expect(mocks.setOrganizationLogo).toHaveBeenLastCalledWith(CLIENT_ORG, null);
    });

    it("rejects a bad image or id and answers 404 for an unknown client", async () => {
      const headers = as(SAME_ORG, "admin", "platform-user");
      expect((await app.inject({ method: "PATCH", url, headers, payload: { logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PATCH", url: "/platform/organizations/nope/logo", headers, payload: { logo: null } })).statusCode).toBe(400);
      mocks.setOrganizationLogo.mockResolvedValue(undefined);
      expect((await app.inject({ method: "PATCH", url, headers, payload: { logo: null } })).statusCode).toBe(404);
    });
  });

  describe("the fleets of a client", () => {
    const base = `/platform/organizations/${CLIENT_ORG}/fleets`;
    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    it("are read and set by OneSystec alone, in the chosen client", async () => {
      fleetMocks.listFleetDetails.mockResolvedValue([]);
      fleetMocks.setFleetLogo.mockResolvedValue({ name: "DHL", logo: PNG });
      mocks.getOrganizationBrief.mockResolvedValue({ id: CLIENT_ORG, name: "Cliente", logo: null });
      const other = as(SAME_ORG, "owner", "u1");
      expect((await app.inject({ method: "GET", url: base, headers: other })).statusCode).toBe(403);
      expect((await app.inject({ method: "PUT", url: `${base}/logo`, headers: other, payload: { name: "DHL", logo: PNG } })).statusCode).toBe(403);
      expect(fleetMocks.setFleetLogo).not.toHaveBeenCalled();

      const mine = as(SAME_ORG, "admin", "platform-user");
      expect((await app.inject({ method: "GET", url: base, headers: mine })).statusCode).toBe(200);
      expect(fleetMocks.listFleetDetails).toHaveBeenCalledWith(CLIENT_ORG);
      expect((await app.inject({ method: "PUT", url: `${base}/logo`, headers: mine, payload: { name: "DHL", logo: PNG } })).statusCode).toBe(200);
      expect(fleetMocks.setFleetLogo).toHaveBeenCalledWith(CLIENT_ORG, "DHL", PNG);
    });

    it("lets OneSystec create the administrator account of a fleet, and 404s for an unknown client", async () => {
      fleetMocks.createFleetAdmin.mockResolvedValue({ id: "new" });
      const body = { fleet: "DHL", name: "Ana", email: "ana@x.it", password: "12345678" };
      const mine = as(SAME_ORG, "admin", "platform-user");
      mocks.getOrganizationBrief.mockResolvedValue(undefined);
      expect((await app.inject({ method: "POST", url: `${base}/admin`, headers: mine, payload: body })).statusCode).toBe(404);
      mocks.getOrganizationBrief.mockResolvedValue({ id: CLIENT_ORG, name: "Cliente", logo: null });
      expect((await app.inject({ method: "POST", url: `${base}/admin`, headers: as(SAME_ORG, "owner", "u1"), payload: body })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `${base}/admin`, headers: mine, payload: body })).statusCode).toBe(201);
      expect(fleetMocks.createFleetAdmin).toHaveBeenCalledWith(CLIENT_ORG, "DHL", { name: "Ana", email: "ana@x.it", password: "12345678" });
    });
  });
});
