import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PLATFORM_ORG_IDS = "11111111-1111-4111-8111-111111111111";
const PLATFORM_ORG = "11111111-1111-4111-8111-111111111111";
const CLIENT_ORG = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ listOrganizations: vi.fn(), createClientOrganization: vi.fn(), getOrganizationDetail: vi.fn() }));
vi.mock("../../src/services/platform.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platform.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");

describe("cross-client administration is OneSystec's alone", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listOrganizations.mockResolvedValue([]);
  });

  const as = (orgId: string, role: string, userId = "u1") => ({
    authorization: `Bearer ${app.jwt.sign({ userId, orgId, role, allowedArea: null } as never)}`,
  });
  const body = { orgName: "Cliente Nuevo", email: "nuevo@cliente.it", password: "12345678" };

  it("refuses a client's owner and admin on every platform route", async () => {
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(CLIENT_ORG, role) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/platform/organizations", headers: as(CLIENT_ORG, role), payload: body })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(CLIENT_ORG, role) })).statusCode).toBe(403);
    }
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
    expect(mocks.createClientOrganization).not.toHaveBeenCalled();
  });

  it("refuses OneSystec's own managers and viewers: it takes an owner or admin", async () => {
    for (const role of ["manager", "viewer"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(PLATFORM_ORG, role) })).statusCode).toBe(403);
    }
  });

  it("refuses unauthenticated requests", async () => {
    expect((await app.inject({ method: "GET", url: "/platform/organizations" })).statusCode).toBe(401);
  });

  it("lets OneSystec's owner and admin list, read and create clients", async () => {
    mocks.createClientOrganization.mockResolvedValue({ orgId: CLIENT_ORG, user: { id: "u9" } });
    mocks.getOrganizationDetail.mockResolvedValue({ id: CLIENT_ORG });
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/platform/organizations", headers: as(PLATFORM_ORG, role) })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(PLATFORM_ORG, role) })).statusCode).toBe(200);
      const created = await app.inject({ method: "POST", url: "/platform/organizations", headers: as(PLATFORM_ORG, role), payload: body });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ orgId: CLIENT_ORG, userId: "u9" });
    }
  });

  it("returns 404 for an unknown client and 400 for a malformed id", async () => {
    mocks.getOrganizationDetail.mockResolvedValue(undefined);
    expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT_ORG}`, headers: as(PLATFORM_ORG, "owner") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/platform/organizations/nope", headers: as(PLATFORM_ORG, "owner") })).statusCode).toBe(400);
  });
});
