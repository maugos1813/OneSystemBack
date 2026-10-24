import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** GET /driver-vehicles: only for a client with a flota, with the map section and the Driver product. */

const state = vi.hoisted(() => ({ granted: [] as string[], products: [] as string[] }));
const mocks = vi.hoisted(() => ({ list: vi.fn(), me: vi.fn() }));

vi.mock("../../src/services/userModules.service.js", () => ({ getUserModules: async () => state.granted }));
vi.mock("../../src/services/product.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/product.service.js")>()),
  getProductsForUser: async () => state.products.map((key) => ({ key })),
}));
vi.mock("../../src/services/auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/auth.service.js")>()),
  getCurrentUser: mocks.me,
}));
vi.mock("../../src/services/driverVehicles.service.js", () => ({ listDriverVehiclesFor: mocks.list }));

const { buildApp } = await import("../../src/api/app.js");

describe("the Gamonal vehicles on a client's map", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([{ plate: "AB123CD", lat: 1, lng: 2 }]);
    mocks.me.mockReset().mockResolvedValue({ email: "p@piazza.it" });
    state.granted = ["mapa"];
    state.products = ["gps", "driver"];
  });

  const as = (role: string, allowedArea: string | null = "PIAZZA") => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea } as never)}`,
  });

  it("asks the Driver as the person who is looking", async () => {
    const res = await app.inject({ method: "GET", url: "/driver-vehicles", headers: as("viewer") });
    expect(res.statusCode).toBe(200);
    expect(res.json().vehicles).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledWith("p@piazza.it");
  });

  it("gives nothing to someone with no flota (the organization's own people already see everything)", async () => {
    const res = await app.inject({ method: "GET", url: "/driver-vehicles", headers: as("owner", null) });
    expect(res.json().vehicles).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("gives nothing without the Driver product, and refuses without the map section", async () => {
    state.products = ["gps"];
    expect((await app.inject({ method: "GET", url: "/driver-vehicles", headers: as("viewer") })).json().vehicles).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();

    state.products = ["gps", "driver"];
    state.granted = ["alertas"];
    expect((await app.inject({ method: "GET", url: "/driver-vehicles", headers: as("viewer") })).statusCode).toBe(403);
  });

  it("needs a signed-in person", async () => {
    expect((await app.inject({ method: "GET", url: "/driver-vehicles" })).statusCode).toBe(401);
  });
});
