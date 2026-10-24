import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveToken: vi.fn(), removeToken: vi.fn() }));
vi.mock("../../src/services/push.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/push.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const TOKEN = "fcm-token-".padEnd(60, "x");

describe("/push-tokens", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mocks.saveToken.mockReset();
    mocks.removeToken.mockReset();
  });
  const as = (role = "viewer") => ({ authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role, allowedArea: "PIAZZA" } as never)}` });

  it("registers the phone of whoever is signed in, for any role", async () => {
    for (const role of ["viewer", "manager", "admin", "owner"]) {
      const res = await app.inject({ method: "POST", url: "/push-tokens", headers: as(role), payload: { token: TOKEN } });
      expect(res.statusCode, role).toBe(204);
    }
    expect(mocks.saveToken).toHaveBeenLastCalledWith("u1", "org-1", TOKEN, "android");
  });

  it("needs a session, and refuses an API key", async () => {
    expect((await app.inject({ method: "POST", url: "/push-tokens", payload: { token: TOKEN } })).statusCode).toBe(401);
    const key = "osk_live_" + "0".repeat(48);
    const withKey = await app.inject({ method: "POST", url: "/push-tokens", headers: { authorization: `Bearer ${key}` }, payload: { token: TOKEN } });
    expect(withKey.statusCode).toBe(403);
    expect(mocks.saveToken).not.toHaveBeenCalled();
  });

  it("rejects a token that is too short or a platform that does not exist", async () => {
    expect((await app.inject({ method: "POST", url: "/push-tokens", headers: as(), payload: { token: "corto" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/push-tokens", headers: as(), payload: { token: TOKEN, platform: "toaster" } })).statusCode).toBe(400);
  });

  it("unregisters a phone", async () => {
    const res = await app.inject({ method: "POST", url: "/push-tokens/unregister", headers: as(), payload: { token: TOKEN } });
    expect(res.statusCode).toBe(204);
    expect(mocks.removeToken).toHaveBeenCalledWith("u1", TOKEN);
  });
});
