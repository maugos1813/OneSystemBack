import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isForeignKeyViolation, isUniqueViolation, pgErrorCode } from "../../src/api/pgError.js";

const mocks = vi.hoisted(() => ({ getTeamMember: vi.fn(), updateTeamMemberEmail: vi.fn() }));
vi.mock("../../src/services/teamUser.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/teamUser.service.js")>()),
  ...mocks,
}));

const { buildApp } = await import("../../src/api/app.js");
const MEMBER = "123e4567-e89b-12d3-a456-426614174000";

/** What Drizzle throws: its own "Failed query" error, with the database's error (the one that has the code) as its cause. */
const drizzleError = (code: string) => Object.assign(new Error("Failed query: update ..."), { cause: Object.assign(new Error("duplicate key"), { code }) });

describe("telling what went wrong in the database", () => {
  it("finds the code on the error itself or on its cause", () => {
    expect(pgErrorCode({ code: "23505" })).toBe("23505");
    expect(pgErrorCode(drizzleError("23505"))).toBe("23505");
    expect(pgErrorCode(new Error("plain"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(isUniqueViolation(drizzleError("23505"))).toBe(true);
    expect(isUniqueViolation(drizzleError("23503"))).toBe(false);
    expect(isForeignKeyViolation(drizzleError("23503"))).toBe(true);
  });
});

describe("changing the email of a team member to one that is already taken", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("answers 409 (not a server error), whether the database error arrives bare or wrapped by Drizzle", async () => {
    mocks.getTeamMember.mockResolvedValue({ id: MEMBER, role: "viewer", parentUserId: null });
    const headers = { authorization: `Bearer ${app.jwt.sign({ userId: "u1", orgId: "org-1", role: "owner", allowedArea: null } as never)}` };
    for (const error of [Object.assign(new Error("dup"), { code: "23505" }), drizzleError("23505")]) {
      mocks.updateTeamMemberEmail.mockRejectedValue(error);
      const res = await app.inject({ method: "PATCH", url: `/users/${MEMBER}/email`, headers, payload: { email: "taken@x.it" } });
      expect(res.statusCode).toBe(409);
    }
  });
});
