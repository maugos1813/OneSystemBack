import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getTagliando: vi.fn(), registerTagliando: vi.fn() }));
const granted = vi.hoisted(() => ({ modules: ["mantenimiento"] as string[] }));
vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => granted.modules }));
vi.mock("../../src/services/tagliando.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/tagliando.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const { MaintenanceError } = await import("../../src/services/maintenance.service.js");

const VEHICLE = "123e4567-e89b-12d3-a456-426614174000";
const URL = `/maintenance/vehicles/${VEHICLE}/tagliando`;

describe("tagliando routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const as = (role: string, allowedArea: string | null = null) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getTagliando.mockResolvedValue({ kmRemaining: 1500 });
    mocks.registerTagliando.mockResolvedValue({ kmRemaining: 1500 });
    granted.modules = ["mantenimiento"];
  });

  it("is read by anyone with the section, scoped to their área, and closed to those without it", async () => {
    expect((await app.inject({ method: "GET", url: URL, headers: as("viewer", "DHL") })).statusCode).toBe(200);
    expect(mocks.getTagliando).toHaveBeenCalledWith("org-1", "DHL", VEHICLE);
    granted.modules = ["mapa"];
    expect((await app.inject({ method: "GET", url: URL, headers: as("viewer") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/maintenance/vehicles/nope/tagliando", headers: as("admin") })).statusCode).toBe(400);
  });

  it("is entered only by owner, admin and manager, with whole km", async () => {
    const put = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "PUT", url: URL, headers, payload: payload as never });
    for (const role of ["owner", "admin", "manager"]) expect((await put(as(role), { km: 60000 })).statusCode, role).toBe(200);
    expect((await put(as("viewer"), { km: 60000 })).statusCode).toBe(403);
    expect((await put(as("admin"), { km: -1 })).statusCode).toBe(400);
    expect((await put(as("admin"), { km: 60000.5 })).statusCode).toBe(400);
    expect((await put(as("admin"), { km: 60000, mode: "other" })).statusCode).toBe(400);
    expect(mocks.registerTagliando).toHaveBeenLastCalledWith("org-1", null, VEHICLE, expect.objectContaining({ km: 60000 }));
  });

  it("answers a refused tagliando with the reason", async () => {
    mocks.registerTagliando.mockRejectedValue(new MaintenanceError(400, "No puede ser a más km"));
    const res = await app.inject({ method: "PUT", url: URL, headers: as("admin"), payload: { km: 99999 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "No puede ser a más km" });
  });
});
