import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listFleetPictures: vi.fn(), setFleetLogo: vi.fn() }));
vi.mock("../../src/services/fleet.service.js", () => mocks);

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

  it("no longer has routes to manage fleets apart from the team", async () => {
    for (const [method, url] of [["GET", "/fleets/manage"], ["PUT", "/fleets/logo"], ["POST", "/fleets/admin"]] as const) {
      expect((await app.inject({ method, url, headers: as("owner"), payload: {} })).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
