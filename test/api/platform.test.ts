import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAME_ORG = "11111111-1111-4111-8111-111111111111";
const CLIENT_ORG = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  isPlatformUser: vi.fn(async (id: string) => id === "platform-user"),
  listOrganizations: vi.fn(),
  createClientOrganization: vi.fn(),
  getOrganizationDetail: vi.fn(),
  getOrganizationBrief: vi.fn(),
}));
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
});
