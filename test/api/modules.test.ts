import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ granted: ["mapa"] as string[] }));
const mocks = vi.hoisted(() => ({
  createTeamMember: vi.fn(),
  getTeamMember: vi.fn(),
  updateTeamMemberModules: vi.fn(),
}));

vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => state.granted }));
vi.mock("../../src/services/teamUser.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/teamUser.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");

const MEMBER = "123e4567-e89b-12d3-a456-426614174000";
const VEHICLE = "223e4567-e89b-12d3-a456-426614174000";

describe("sections enforced by the server", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    state.granted = ["mapa"];
  });

  const as = (role: string, userId = "u1") => ({
    authorization: `Bearer ${app.jwt.sign({ userId, orgId: "org-1", role, allowedArea: null } as never)}`,
  });

  it("refuses Peajes, Conducción and the history to a client whose account doesn't include them", async () => {
    const urls = [
      "/tolls/months",
      "/tolls/passages",
      "/driving-style",
      `/vehicles/${VEHICLE}/driving-style/incidents`,
      `/vehicles/${VEHICLE}/positions`,
    ];
    for (const url of urls) {
      for (const role of ["viewer", "manager"]) {
        const res = await app.inject({ method: "GET", url, headers: as(role) });
        expect(res.statusCode, `${role} ${url}`).toBe(403);
      }
    }
  });

  it("lets the same routes past the gate once the section is granted (Cockpit also reads driving style)", async () => {
    state.granted = ["peajes"];
    expect((await app.inject({ method: "GET", url: "/tolls/months", headers: as("viewer") })).statusCode).not.toBe(403);
    state.granted = ["cockpit"];
    expect((await app.inject({ method: "GET", url: "/driving-style", headers: as("viewer") })).statusCode).not.toBe(403);
    state.granted = ["analiticas"];
    expect((await app.inject({ method: "GET", url: `/vehicles/${VEHICLE}/positions`, headers: as("viewer") })).statusCode).not.toBe(403);
  });

  it("never gates owner or admin", async () => {
    state.granted = [];
    for (const role of ["owner", "admin"]) {
      expect((await app.inject({ method: "GET", url: "/tolls/months", headers: as(role) })).statusCode, role).not.toBe(403);
    }
  });

  it("creates a client with the sections the admin picked, and rejects an unknown one", async () => {
    mocks.createTeamMember.mockResolvedValue({ id: "m1" });
    const payload = { name: "DHL", email: "dhl@c.it", password: "supersecret1", role: "viewer", modules: ["mapa", "historial"] };
    expect((await app.inject({ method: "POST", url: "/users", headers: as("admin"), payload })).statusCode).toBe(201);
    expect(mocks.createTeamMember).toHaveBeenCalledWith(expect.objectContaining({ modules: ["mapa", "historial"] }));
    const bad = await app.inject({ method: "POST", url: "/users", headers: as("admin"), payload: { ...payload, modules: ["dispositivos"] } });
    expect(bad.statusCode).toBe(400);
  });

  it("lets an admin change a client's sections, but not a viewer's own, and never the owner's", async () => {
    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: null });
    mocks.updateTeamMemberModules.mockResolvedValue({ id: MEMBER, modules: ["mapa"] });
    const url = `/users/${MEMBER}/modules`;

    expect((await app.inject({ method: "PATCH", url, headers: as("viewer"), payload: { modules: ["peajes"] } })).statusCode).toBe(403);
    expect(mocks.updateTeamMemberModules).not.toHaveBeenCalled();

    expect((await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { modules: ["mapa", "peajes"] } })).statusCode).toBe(200);
    expect(mocks.updateTeamMemberModules).toHaveBeenLastCalledWith("org-1", MEMBER, ["mapa", "peajes"]);

    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "owner", parentUserId: null });
    expect((await app.inject({ method: "PATCH", url, headers: as("admin"), payload: { modules: ["mapa"] } })).statusCode).toBe(403);
  });

  it("stops a manager from granting a section they don't have, or touching users that aren't theirs", async () => {
    mocks.updateTeamMemberModules.mockResolvedValue({ id: MEMBER, modules: ["mapa"] });
    const url = `/users/${MEMBER}/modules`;
    state.granted = ["mapa", "historial"];

    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: "someone-else" });
    expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { modules: ["mapa"] } })).statusCode).toBe(403);

    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: "u1" });
    expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { modules: ["mapa", "peajes"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url, headers: as("manager"), payload: { modules: ["mapa"] } })).statusCode).toBe(200);
  });
});
