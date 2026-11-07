import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ row: undefined as { email: string; role: string } | undefined }));
vi.mock("../../src/db/client.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.row ? [state.row] : []) }) }) }) },
}));

process.env.PLATFORM_ADMIN_EMAILS = " OneSystecSrl@Gmail.com ";
const { isPlatformEmail, isPlatformUser, platformEmails } = await import("../../src/services/platform.service.js");

describe("who is the platform", () => {
  it("nobody when the variable is unset or empty (fails closed)", () => {
    expect(isPlatformEmail("a@b.c", "")).toBe(false);
    expect(isPlatformEmail("a@b.c", undefined)).toBe(false);
    expect(platformEmails(" , ")).toEqual([]);
  });
  it("matches listed emails, ignoring case and spaces", () => {
    expect(isPlatformEmail("ONESYSTECSRL@gmail.com ", "onesystecsrl@gmail.com, otro@x.it")).toBe(true);
    expect(isPlatformEmail("otro@x.it", "onesystecsrl@gmail.com,otro@x.it")).toBe(true);
    expect(isPlatformEmail("maufabagosgam@gmail.com", "onesystecsrl@gmail.com")).toBe(false);
  });
  it("never matches a missing email", () => {
    expect(isPlatformEmail(undefined, "a@b.c")).toBe(false);
    expect(isPlatformEmail(null, "a@b.c")).toBe(false);
  });
});

describe("isPlatformUser reads the account from the database", () => {
  beforeEach(() => {
    state.row = undefined;
  });
  it("accepts the listed email as owner or admin, whatever organization it is in", async () => {
    state.row = { email: "onesystecsrl@gmail.com", role: "admin" };
    expect(await isPlatformUser("u1")).toBe(true);
    state.row = { email: "onesystecsrl@gmail.com", role: "owner" };
    expect(await isPlatformUser("u1")).toBe(true);
  });
  it("refuses another email, a lower role and an unknown user", async () => {
    state.row = { email: "info@gamonaltrasporti.com", role: "owner" };
    expect(await isPlatformUser("u1")).toBe(false);
    state.row = { email: "onesystecsrl@gmail.com", role: "viewer" };
    expect(await isPlatformUser("u1")).toBe(false);
    state.row = undefined;
    expect(await isPlatformUser("u1")).toBe(false);
  });
});
