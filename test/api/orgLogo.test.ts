import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerOrganizationWithOwner: vi.fn(),
  updateSettings: vi.fn(),
  createTeamMember: vi.fn(),
  getTeamMember: vi.fn(),
  updateTeamMemberLogo: vi.fn(),
  getUserProductKeys: vi.fn(),
}));

vi.mock("../../src/services/auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/auth.service.js")>()),
  registerOrganizationWithOwner: mocks.registerOrganizationWithOwner,
}));
vi.mock("../../src/services/settings.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/settings.service.js")>()),
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../src/services/teamUser.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/teamUser.service.js")>()),
  createTeamMember: mocks.createTeamMember,
  getTeamMember: mocks.getTeamMember,
  updateTeamMemberLogo: mocks.updateTeamMemberLogo,
  getUserProductKeys: mocks.getUserProductKeys,
}));

const { buildApp } = await import("../../src/api/app.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("logo in the routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  const as = (role: string) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea: null } as never)}`,
  });
  const MEMBER = "123e4567-e89b-12d3-a456-426614174000";

  it("passes the logo to the registration, and rejects a bad one before touching the service", async () => {
    mocks.registerOrganizationWithOwner.mockResolvedValue({ orgId: "o", user: { id: "u", role: "owner", allowedArea: null } });
    const ok = await app.inject({ method: "POST", url: "/auth/register", payload: { orgName: "Gamonal", email: "a@b.it", password: "supersecret1", logo: PNG } });
    expect(ok.statusCode).toBe(201);
    expect(mocks.registerOrganizationWithOwner).toHaveBeenCalledWith(expect.objectContaining({ logo: PNG }));

    mocks.registerOrganizationWithOwner.mockClear();
    const bad = await app.inject({ method: "POST", url: "/auth/register", payload: { orgName: "Gamonal", email: "a@b.it", password: "supersecret1", logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
    expect(bad.statusCode).toBe(400);
    expect(mocks.registerOrganizationWithOwner).not.toHaveBeenCalled();
  });

  it("lets only owner/admin change or remove the logo in the settings", async () => {
    mocks.updateSettings.mockResolvedValue({ orgName: "Gamonal" });
    const viewer = await app.inject({ method: "PATCH", url: "/settings", headers: as("viewer"), payload: { orgLogo: PNG } });
    expect(viewer.statusCode).toBe(403);
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    const set = await app.inject({ method: "PATCH", url: "/settings", headers: as("owner"), payload: { orgLogo: PNG } });
    expect(set.statusCode).toBe(200);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith("org-1", { orgLogo: PNG });

    await app.inject({ method: "PATCH", url: "/settings", headers: as("admin"), payload: { orgLogo: null } });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith("org-1", { orgLogo: null });

    const bad = await app.inject({ method: "PATCH", url: "/settings", headers: as("owner"), payload: { orgLogo: "not-an-image" } });
    expect(bad.statusCode).toBe(400);
  });

  it("gives a new user their logo when the admin creates them, and rejects a bad one", async () => {
    mocks.createTeamMember.mockResolvedValue({ id: "m1" });
    const payload = { name: "DHL", email: "dhl@cliente.it", password: "supersecret1", role: "viewer", allowedArea: "DHL", logo: PNG };
    const ok = await app.inject({ method: "POST", url: "/users", headers: as("admin"), payload });
    expect(ok.statusCode).toBe(201);
    expect(mocks.createTeamMember).toHaveBeenCalledWith(expect.objectContaining({ logo: PNG, allowedArea: "DHL" }));

    mocks.createTeamMember.mockClear();
    const bad = await app.inject({ method: "POST", url: "/users", headers: as("admin"), payload: { ...payload, logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
    expect(bad.statusCode).toBe(400);
    expect(mocks.createTeamMember).not.toHaveBeenCalled();
  });

  it("lets an admin change or remove a user's logo, but not a viewer, and never the owner's", async () => {
    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: null });
    mocks.updateTeamMemberLogo.mockResolvedValue({ id: MEMBER, logo: PNG });
    const url = `/users/${MEMBER}/logo`;

    expect((await app.inject({ method: "PATCH", url, headers: as("viewer"), payload: { logo: PNG } })).statusCode).toBe(403);
    expect(mocks.updateTeamMemberLogo).not.toHaveBeenCalled();

    expect((await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { logo: PNG } })).statusCode).toBe(200);
    expect(mocks.updateTeamMemberLogo).toHaveBeenLastCalledWith("org-1", MEMBER, PNG);
    await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { logo: null } });
    expect(mocks.updateTeamMemberLogo).toHaveBeenLastCalledWith("org-1", MEMBER, null);

    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "owner", parentUserId: null });
    expect((await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { logo: PNG } })).statusCode).toBe(403);
  });

  it("lets a manager set the logo only of the sub-users they created", async () => {
    const url = `/users/${MEMBER}/logo`;
    mocks.updateTeamMemberLogo.mockResolvedValue({ id: MEMBER, logo: PNG });
    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: "someone-else" });
    expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { logo: PNG } })).statusCode).toBe(403);
    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: "u1" });
    expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { logo: PNG } })).statusCode).toBe(200);
  });
});
