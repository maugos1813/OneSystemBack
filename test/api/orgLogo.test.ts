import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ registerOrganizationWithOwner: vi.fn(), updateSettings: vi.fn() }));

vi.mock("../../src/services/auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/auth.service.js")>()),
  registerOrganizationWithOwner: mocks.registerOrganizationWithOwner,
}));
vi.mock("../../src/services/settings.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/settings.service.js")>()),
  updateSettings: mocks.updateSettings,
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
    mocks.registerOrganizationWithOwner.mockReset();
    mocks.updateSettings.mockReset();
  });

  const as = (role: string) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea: null } as never)}`,
  });

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
});
