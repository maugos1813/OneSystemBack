import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), registerOrganizationWithOwner: vi.fn() }));
vi.mock("../../src/services/auth.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/auth.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const { LOGIN_LIMITS, REGISTER_LIMIT_PER_HOUR, resetLoginLimits } = await import("../../src/api/middlewares/loginRateLimit.js");

describe("login and registration limits", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    resetLoginLimits();
    mocks.authenticate.mockReset().mockResolvedValue(null);
    mocks.registerOrganizationWithOwner.mockReset().mockResolvedValue({ orgId: "org-1", user: { id: "u1", role: "owner", allowedArea: null } });
  });

  const login = (email: string, remoteAddress = "10.0.0.1", headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/auth/login", remoteAddress, headers, payload: { email, password: "wrong-password" } });

  it("answers 401 to a wrong password until the limit for that account, then 429 with Retry-After", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAddressAndEmail; i++) expect((await login("a@x.com")).statusCode).toBe(401);
    const blocked = await login("a@x.com");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(mocks.authenticate).toHaveBeenCalledTimes(LOGIN_LIMITS.perAddressAndEmail); // the password is not even checked once blocked
  });

  it("does not let one account's lock affect another account, nor the same account from another address", async () => {
    for (let i = 0; i <= LOGIN_LIMITS.perAddressAndEmail; i++) await login("a@x.com");
    expect((await login("b@x.com")).statusCode).toBe(401);
    expect((await login("a@x.com", "10.0.0.2")).statusCode).toBe(401);
  });

  it("counts the email without regard to case or spaces", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAddressAndEmail; i++) await login(i % 2 ? "A@X.com" : "a@X.COM");
    expect((await login("a@x.com")).statusCode).toBe(429);
  });

  it("stops one address trying many accounts", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) expect((await login(`user${i}@x.com`)).statusCode).toBe(401);
    expect((await login("another@x.com")).statusCode).toBe(429);
  });

  it("still lets a right password in", async () => {
    mocks.authenticate.mockResolvedValue({ id: "u1", orgId: "org-1", role: "owner", allowedArea: null });
    const res = await login("a@x.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("token");
  });

  it("tells clients apart by the address Railway's edge reports in X-Real-IP, not by the edge's own address", async () => {
    // Every request reaches the app from a different edge address, but the client is the same.
    for (let i = 0; i < LOGIN_LIMITS.perAddressAndEmail; i++) await login("a@x.com", `152.233.12.${i}`, { "x-real-ip": "203.0.113.7" });
    expect((await login("a@x.com", "152.233.99.1", { "x-real-ip": "203.0.113.7" })).statusCode).toBe(429);
    expect((await login("a@x.com", "152.233.99.1", { "x-real-ip": "203.0.113.8" })).statusCode).toBe(401);
  });

  it("limits how many organizations one address can open per hour", async () => {
    const register = () =>
      app.inject({ method: "POST", url: "/auth/register", remoteAddress: "10.0.0.9", payload: { orgName: "Acme", email: "o@x.com", password: "a-long-password" } });
    for (let i = 0; i < REGISTER_LIMIT_PER_HOUR; i++) expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(429);
  });

  it("adds the security headers to every API answer", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(res.headers["strict-transport-security"])).toContain("max-age=");
  });
});
