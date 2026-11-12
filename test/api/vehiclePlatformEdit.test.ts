import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OneSystec's overview lists every client's vehicles and devices: a sheet, an edit or a command on one of them is carried out on the
 * client that owns it. Nobody else gets that, and a read-only look at a client's account never does.
 */
const who = vi.hoisted(() => ({ platform: false, owner: "client-org" as string | undefined }));
const mocks = vi.hoisted(() => ({
  updateVehicle: vi.fn(),
  deviceInOrg: vi.fn(),
  getDeviceDetail: vi.fn(),
  listDeviceCommands: vi.fn(),
}));
vi.mock("../../src/services/platform.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platform.service.js")>()),
  isPlatformUser: async () => who.platform,
  owningOrgOf: async () => who.owner,
}));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  updateVehicle: mocks.updateVehicle,
  deviceInOrg: mocks.deviceInOrg,
}));
vi.mock("../../src/services/device.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/device.service.js")>()),
  getDeviceDetail: mocks.getDeviceDetail,
}));
vi.mock("../../src/services/deviceCommand.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/deviceCommand.service.js")>()),
  listDeviceCommands: mocks.listDeviceCommands,
}));

const { buildApp } = await import("../../src/api/app.js");
const VEHICLE = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const CLIENT_ORG = "client-org";

describe("a vehicle or a device of another client", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.updateVehicle.mockResolvedValue({ id: VEHICLE });
    mocks.deviceInOrg.mockResolvedValue(true);
    mocks.getDeviceDetail.mockResolvedValue({ device: { id: DEVICE, imei: "1", model: "FMB204" }, io: [], sim: null });
    mocks.listDeviceCommands.mockResolvedValue([]);
    who.platform = false;
    who.owner = CLIENT_ORG;
  });
  const owner = (extra: object = {}) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "own-org", role: "owner", allowedArea: null, ...extra } as never)}`,
  });
  const patch = (headers: Record<string, string>, payload: object) => app.inject({ method: "PATCH", url: `/vehicles/${VEHICLE}`, headers, payload: payload as never });

  it("is edited on its own client when OneSystec asks", async () => {
    who.platform = true;
    expect((await patch(owner(), { plate: "AB123CD", deviceId: DEVICE })).statusCode).toBe(200);
    expect(mocks.updateVehicle).toHaveBeenCalledWith(CLIENT_ORG, VEHICLE, expect.objectContaining({ plate: "AB123CD", deviceId: DEVICE }));
    expect(mocks.deviceInOrg).toHaveBeenCalledWith(CLIENT_ORG, DEVICE);
  });

  it("refuses a device that belongs to another client", async () => {
    who.platform = true;
    mocks.deviceInOrg.mockResolvedValue(false);
    expect((await patch(owner(), { deviceId: DEVICE })).statusCode).toBe(400);
    expect(mocks.updateVehicle).not.toHaveBeenCalled();
  });

  it("opens a device's sheet on its own client when OneSystec asks", async () => {
    who.platform = true;
    expect((await app.inject({ method: "GET", url: `/devices/${DEVICE}`, headers: owner() })).statusCode).toBe(200);
    expect(mocks.getDeviceDetail).toHaveBeenCalledWith(CLIENT_ORG, DEVICE, expect.anything());
    expect((await app.inject({ method: "GET", url: `/devices/${DEVICE}/commands`, headers: owner() })).statusCode).toBe(200);
    expect(mocks.listDeviceCommands).toHaveBeenCalledWith(CLIENT_ORG, DEVICE);
  });

  it("stays in the caller's own organization for anyone else", async () => {
    await patch(owner(), { plate: "AB123CD" });
    expect(mocks.updateVehicle).toHaveBeenCalledWith("own-org", VEHICLE, expect.anything());
    await app.inject({ method: "GET", url: `/devices/${DEVICE}`, headers: owner() });
    expect(mocks.getDeviceDetail).toHaveBeenCalledWith("own-org", DEVICE, expect.anything());
  });

  it("is never reached through a read-only look at a client's account", async () => {
    who.platform = true;
    expect((await patch(owner({ viewAs: true }), { plate: "AB123CD" })).statusCode).toBe(403);
    expect(mocks.updateVehicle).not.toHaveBeenCalled();
  });

  it("leaves the caller's own organization alone when the thing is its own or does not exist", async () => {
    who.platform = true;
    who.owner = "own-org";
    await patch(owner(), { plate: "AB123CD" });
    expect(mocks.updateVehicle).toHaveBeenLastCalledWith("own-org", VEHICLE, expect.anything());
    who.owner = undefined;
    await patch(owner(), { plate: "ZZ999ZZ" });
    expect(mocks.updateVehicle).toHaveBeenLastCalledWith("own-org", VEHICLE, expect.anything());
  });
});
