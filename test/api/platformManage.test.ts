import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** "Manage this client": OneSystec gets a two-hour token to change a client's account, every opening and every change is logged. */
const who = vi.hoisted(() => ({ platform: true }));
const mocks = vi.hoisted(() => ({
  logPlatformAccess: vi.fn(),
  getOrganizationBrief: vi.fn(),
  listPlatformAccess: vi.fn(),
  updateVehicle: vi.fn(),
}));
vi.mock("../../src/services/platform.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platform.service.js")>()),
  isPlatformUser: async () => who.platform,
  owningOrgOf: async () => undefined,
  logPlatformAccess: mocks.logPlatformAccess,
  getOrganizationBrief: mocks.getOrganizationBrief,
  listPlatformAccess: mocks.listPlatformAccess,
}));
vi.mock("../../src/services/vehicle.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/vehicle.service.js")>()),
  updateVehicle: mocks.updateVehicle,
}));

const { buildApp } = await import("../../src/api/app.js");
const CLIENT = "22222222-2222-4222-8222-222222222222";
const VEHICLE = "33333333-3333-4333-8333-333333333333";

describe("managing a client's account as OneSystec", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getOrganizationBrief.mockResolvedValue({ id: CLIENT, name: "Cliente" });
    mocks.updateVehicle.mockResolvedValue({ id: VEHICLE });
    mocks.listPlatformAccess.mockResolvedValue([]);
    who.platform = true;
  });
  const sign = (extra: object, orgId = "own-org") => ({
    authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId, role: "owner", allowedArea: null, ...extra } as never, { expiresIn: "1h" })}`,
  });
  const decode = (token: string) => app.jwt.decode<{ orgId: string; actingAs?: boolean; viewAs?: boolean }>(token)!;

  it("gives OneSystec a token for the client with write permission, and writes the opening down", async () => {
    const res = await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT}/manage`, headers: sign({}) });
    expect(res.statusCode).toBe(200);
    expect(decode(res.json().token)).toMatchObject({ orgId: CLIENT, actingAs: true });
    expect(decode(res.json().token).viewAs).toBeUndefined();
    expect(mocks.logPlatformAccess).toHaveBeenCalledWith("u1", CLIENT, "manage");
  });

  it("keeps 'view' read-only and logs it too", async () => {
    const res = await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT}/view`, headers: sign({}) });
    expect(decode(res.json().token)).toMatchObject({ orgId: CLIENT, viewAs: true });
    expect(mocks.logPlatformAccess).toHaveBeenCalledWith("u1", CLIENT, "view");
  });

  it("refuses anyone who is not OneSystec, and opening an account from inside another one", async () => {
    who.platform = false;
    expect((await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT}/manage`, headers: sign({}) })).statusCode).toBe(403);
    who.platform = true;
    expect((await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT}/manage`, headers: sign({ actingAs: true }, CLIENT) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/platform/organizations/${CLIENT}/manage`, headers: sign({ viewAs: true }, CLIENT) })).statusCode).toBe(403);
  });

  it("lets a managing token change things (a read-only one cannot) and logs each change", async () => {
    const patch = (headers: Record<string, string>) => app.inject({ method: "PATCH", url: `/vehicles/${VEHICLE}`, headers, payload: { plate: "AB123CD" } });
    expect((await patch(sign({ viewAs: true }, CLIENT))).statusCode).toBe(403);
    expect(mocks.logPlatformAccess).not.toHaveBeenCalledWith("u1", CLIENT, "write", expect.anything());
    expect((await patch(sign({ actingAs: true }, CLIENT))).statusCode).toBe(200);
    expect(mocks.updateVehicle).toHaveBeenCalledWith(CLIENT, VEHICLE, expect.anything());
    expect(mocks.logPlatformAccess).toHaveBeenCalledWith("u1", CLIENT, "write", "PATCH /vehicles/:id");
  });

  it("stops honouring the token the moment its holder is no longer OneSystec", async () => {
    who.platform = false;
    const res = await app.inject({ method: "PATCH", url: `/vehicles/${VEHICLE}`, headers: sign({ actingAs: true }, CLIENT), payload: { plate: "AB123CD" } });
    expect(res.statusCode).toBe(403);
    expect(mocks.updateVehicle).not.toHaveBeenCalled();
  });

  it("shows the log to OneSystec only", async () => {
    mocks.listPlatformAccess.mockResolvedValue([{ id: "1", action: "manage", detail: null, createdAt: new Date(), userEmail: "a@b.it" }]);
    const ok = await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT}/access-log`, headers: sign({}) });
    expect(ok.statusCode).toBe(200);
    who.platform = false;
    expect((await app.inject({ method: "GET", url: `/platform/organizations/${CLIENT}/access-log`, headers: sign({}) })).statusCode).toBe(403);
  });
});
