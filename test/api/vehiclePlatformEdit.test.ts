import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** OneSystec's overview lists every client's vehicles: editing one acts on its own client, and nobody else gets to do that. */
const who = vi.hoisted(() => ({ platform: false }));
const mocks = vi.hoisted(() => ({
  updateVehicle: vi.fn(),
  getVehicleAnyOrg: vi.fn(),
  deviceInOrg: vi.fn(),
}));
vi.mock("../../src/services/platform.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platform.service.js")>()),
  isPlatformUser: async () => who.platform,
}));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const VEHICLE = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const CLIENT_ORG = "client-org";

describe("editing a vehicle that belongs to another client", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getVehicleAnyOrg.mockResolvedValue({ id: VEHICLE, orgId: CLIENT_ORG });
    mocks.deviceInOrg.mockResolvedValue(true);
    mocks.updateVehicle.mockImplementation(async (orgId: string) => (orgId === CLIENT_ORG ? { id: VEHICLE } : undefined));
    who.platform = false;
  });
  const owner = (extra: object = {}) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "own-org", role: "owner", allowedArea: null, ...extra } as never)}`,
  });
  const patch = (headers: Record<string, string>, payload: object) => app.inject({ method: "PATCH", url: `/vehicles/${VEHICLE}`, headers, payload: payload as never });

  it("lets OneSystec edit it, acting on the client that owns it", async () => {
    who.platform = true;
    const res = await patch(owner(), { plate: "AB123CD", deviceId: DEVICE });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateVehicle).toHaveBeenCalledWith(CLIENT_ORG, VEHICLE, expect.objectContaining({ plate: "AB123CD", deviceId: DEVICE }));
  });

  it("refuses a device that belongs to another client", async () => {
    who.platform = true;
    mocks.deviceInOrg.mockResolvedValue(false);
    expect((await patch(owner(), { deviceId: DEVICE })).statusCode).toBe(400);
    expect(mocks.updateVehicle).not.toHaveBeenCalledWith(CLIENT_ORG, expect.anything(), expect.anything());
  });

  it("does not reach a stranger's vehicle for anyone else: it does not exist for them", async () => {
    expect((await patch(owner(), { plate: "AB123CD" })).statusCode).toBe(404);
    expect(mocks.updateVehicle).toHaveBeenCalledWith("own-org", VEHICLE, expect.anything());
  });

  it("does not let a read-only look at a client's account edit anything of other clients", async () => {
    who.platform = true;
    expect((await patch(owner({ viewAs: true }), { plate: "AB123CD" })).statusCode).toBe(403);
  });
});
