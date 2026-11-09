import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sessions that expire and renew, and the authenticator (TOTP) second step: the whole sign-in as the apps see it, on a real
 * (in-memory) Postgres.
 */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
const alerts = vi.hoisted(() => ({ recordLoginFailure: vi.fn(async () => undefined) }));
vi.mock("../../src/services/platformAlerts.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platformAlerts.service.js")>()),
  ...alerts,
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const { hashPassword } = await import("../../src/services/auth.service.js");
const { hotp, totpStep } = await import("../../src/services/totp.js");
const { resetLoginLimits, resetSecondFactorLimits, SECOND_FACTOR_LIMITS } = await import("../../src/api/middlewares/loginRateLimit.js");
const sessions = await import("../../src/services/userSession.service.js");
const { users, userSessions, userRecoveryCodes } = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

const PASSWORD = "a-long-password-1";
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let counter = 0;

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text,
      plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '',
      email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer',
      parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'es',
      totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_hash varchar(64) NOT NULL, previous_hash varchar(64), rotated_at timestamptz, client varchar(10) NOT NULL DEFAULT 'web',
      mfa boolean NOT NULL DEFAULT false, device varchar(120) NOT NULL DEFAULT '', ip varchar(45),
      created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz
    );
    CREATE TABLE user_recovery_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash varchar(64) NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const [org] = await db.insert((await import("../../src/db/schema/index.js")).organizations).values({ name: "Gamonal" }).returning();
  orgId = org!.id;
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await clientModule.__pg.close();
});

beforeEach(() => {
  resetLoginLimits();
  resetSecondFactorLimits();
  sessions.forgetRevokedSessions();
  alerts.recordLoginFailure.mockClear();
});

const passwordHash = await hashPassword(PASSWORD);
async function makeUser(role: "owner" | "admin" | "manager" | "viewer") {
  const [user] = await db.insert(users).values({ orgId, email: `${role}${++counter}@x.it`, passwordHash, role }).returning();
  return user!;
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress: "10.0.0.1" });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: bearer(token) });
const login = (email: string, extra: Record<string, unknown> = {}) => post("/auth/login", { email, password: PASSWORD, ...extra });

/** Signs a viewer in with no second step and returns what the client keeps. */
async function signIn(email: string, extra: Record<string, unknown> = {}) {
  const res = await login(email, extra);
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; refreshToken: string; sessionId: string; expiresIn: number };
}

/** An admin goes through setup: returns its secret and the first session. */
async function enrollAdmin(email: string) {
  const first = (await login(email)).json();
  expect(first.mfaSetupRequired).toBe(true);
  const setup = (await post("/auth/login/totp/setup", { mfaToken: first.mfaToken })).json() as { secret: string; uri: string };
  const { base32Decode } = await import("../../src/services/totp.js");
  expect(base32Decode(setup.secret)).toHaveLength(20);
  const enabled = await post("/auth/login/totp/enable", { mfaToken: first.mfaToken, code: hotp(setup.secret, totpStep(Date.now())) });
  expect(enabled.statusCode).toBe(200);
  return { secret: setup.secret, session: enabled.json() as { token: string; refreshToken: string; recoveryCodes: string[] } };
}

describe("a session that expires and renews", () => {
  it("opens with a short login token and a refresh token, and lists itself", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email, { client: "app" });
    expect(session.expiresIn).toBe(900);
    const decoded = jwt.decode(session.token) as { exp: number; iat: number; sid: string; userId: string };
    expect(decoded.exp - decoded.iat).toBe(900);
    expect(decoded.sid).toBe(session.sessionId);
    expect(session.refreshToken.startsWith(`${session.sessionId}.`)).toBe(true);

    const list = (await get("/auth/sessions", session.token)).json() as Array<{ id: string; client: string; current: boolean; device: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: session.sessionId, client: "app", current: true, device: "App OneSystec" });
  });

  it("never stores the refresh secret, only its hash", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    const secret = session.refreshToken.split(".")[1]!;
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, session.sessionId));
    expect(row!.refreshHash).toBe(sessions.hashSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("renews with the refresh token, handing out a new one each time", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    const res = await post("/auth/refresh", { refreshToken: session.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json() as { token: string; refreshToken: string; sessionId: string };
    expect(next.sessionId).toBe(session.sessionId);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect((await get("/auth/sessions", next.token)).statusCode).toBe(200);
  });

  it("answers a renewal that was sent twice (the answer got lost) instead of calling it theft", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(200);
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(200);
  });

  it("refuses unknown, malformed or forged refresh tokens", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    const id = session.sessionId;
    for (const refreshToken of ["nonsense", `${id}.wrong-secret`, `00000000-0000-4000-8000-000000000000.${session.refreshToken.split(".")[1]}`, `${id}.a.b`]) {
      expect((await post("/auth/refresh", { refreshToken })).statusCode).toBe(401);
    }
  });

  it("refuses a login token that has run out", async () => {
    const user = await makeUser("viewer");
    const expired = app.jwt.sign({ userId: user.id, orgId, role: "viewer", allowedArea: null }, { expiresIn: -10 });
    expect((await get("/auth/sessions", expired)).statusCode).toBe(401);
  });

  it("refuses a login token that never expires (the ones issued before sessions existed)", async () => {
    const user = await makeUser("viewer");
    const old = jwt.sign({ userId: user.id, orgId, role: "viewer", allowedArea: null }, process.env.JWT_SECRET!);
    expect((await get("/auth/sessions", old)).statusCode).toBe(401);
    expect((await get("/me", old)).statusCode).toBe(401);
  });

  it("signing out ends it at once: the login token stops working and the refresh token with it", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    expect((await post("/auth/logout", {}, bearer(session.token))).statusCode).toBe(204);
    expect((await get("/auth/sessions", session.token)).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it("can sign out with only the refresh token, once the login token has run out", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    expect((await post("/auth/logout", { refreshToken: session.refreshToken })).statusCode).toBe(204);
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
  });

  it("lists my devices and signs out the others, or one of them", async () => {
    const user = await makeUser("viewer");
    const phone = await signIn(user.email, { client: "app" });
    const laptop = await signIn(user.email);
    const tablet = await signIn(user.email);
    expect(((await get("/auth/sessions", phone.token)).json() as unknown[]).length).toBe(3);

    const one = await app.inject({ method: "DELETE", url: `/auth/sessions/${tablet.sessionId}`, headers: bearer(phone.token) });
    expect(one.statusCode).toBe(204);
    expect((await get("/auth/sessions", tablet.token)).statusCode).toBe(401);

    const others = await post("/auth/sessions/revoke-others", {}, bearer(phone.token));
    expect(others.json()).toEqual({ revoked: 1 });
    expect((await get("/auth/sessions", laptop.token)).statusCode).toBe(401);
    expect((await get("/auth/sessions", phone.token)).statusCode).toBe(200);
  });

  it("does not let one user end another's session", async () => {
    const mine = await signIn((await makeUser("viewer")).email);
    const theirs = await signIn((await makeUser("viewer")).email);
    const res = await app.inject({ method: "DELETE", url: `/auth/sessions/${theirs.sessionId}`, headers: bearer(mine.token) });
    expect(res.statusCode).toBe(404);
    expect((await get("/auth/sessions", theirs.token)).statusCode).toBe(200);
  });

  it("changing a password signs out every other device (and keeps the one that changed it)", async () => {
    const user = await makeUser("viewer");
    const phone = await signIn(user.email);
    const laptop = await signIn(user.email);
    const res = await app.inject({ method: "PATCH", url: `/users/${user.id}/password`, headers: bearer(laptop.token), payload: { password: "a-brand-new-password" } });
    expect(res.statusCode).toBe(204);
    expect((await get("/auth/sessions", phone.token)).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: phone.refreshToken })).statusCode).toBe(401);
    expect((await get("/auth/sessions", laptop.token)).statusCode).toBe(200);
  });

  it("renews with what the account is now: a role that changed shows up in the next token", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    await db.update(users).set({ role: "manager" }).where(eq(users.id, user.id));
    const next = (await post("/auth/refresh", { refreshToken: session.refreshToken })).json() as { token: string };
    expect((jwt.decode(next.token) as { role: string }).role).toBe("manager");
  });

  it("an account that became an admin since it signed in must come back through the login to set up its authenticator", async () => {
    const user = await makeUser("viewer");
    const session = await signIn(user.email);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(401);
    expect((await login(user.email)).json().mfaSetupRequired).toBe(true);
  });

  it("names the device in the list from what the browser says", async () => {
    const user = await makeUser("viewer");
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: PASSWORD },
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      remoteAddress: "10.0.0.1",
    });
    const token = (res.json() as { token: string }).token;
    expect(((await get("/auth/sessions", token)).json() as Array<{ device: string }>)[0]!.device).toBe("Chrome · macOS");
  });
});

describe("the session rules", () => {
  it("lets the apps stay a month unused and a browser only a working day, and renewals push that forward", async () => {
    const user = await makeUser("viewer");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const web = await sessions.createSession({ userId: user.id, client: "web", mfa: false, now: t0 });
    const app_ = await sessions.createSession({ userId: user.id, client: "app", mfa: false, now: t0 });
    const hours = (n: number) => new Date(t0.getTime() + n * 3_600_000);

    expect((await sessions.rotateSession(web.refreshToken, hours(7))).outcome).toBe("ok"); // within 8 h
    expect((await sessions.rotateSession(app_.refreshToken, hours(24 * 29))).outcome).toBe("ok"); // within 30 days
  });

  it("ends a browser session unused for 8 hours, however valid its token is", async () => {
    const user = await makeUser("viewer");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const web = await sessions.createSession({ userId: user.id, client: "web", mfa: false, now: t0 });
    expect((await sessions.rotateSession(web.refreshToken, new Date(t0.getTime() + 9 * 3_600_000))).outcome).toBe("expired");
  });

  it("ends a session at its absolute limit even when it is used all the time", async () => {
    const user = await makeUser("viewer");
    const t0 = new Date("2026-01-01T00:00:00Z");
    let current = await sessions.createSession({ userId: user.id, client: "web", mfa: false, now: t0 });
    // Used every 7 hours: never idle, yet it must end by the 24-hour mark.
    let outcome = "ok";
    for (let hour = 7; hour <= 28 && outcome === "ok"; hour += 7) {
      const result = await sessions.rotateSession(current.refreshToken, new Date(t0.getTime() + hour * 3_600_000));
      outcome = result.outcome;
      if (result.outcome === "ok") current = { session: result.session, refreshToken: result.refreshToken };
    }
    expect(outcome).toBe("expired");
  });

  it("takes a replay of an old refresh token for theft and ends the whole session", async () => {
    const user = await makeUser("viewer");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const first = await sessions.createSession({ userId: user.id, client: "web", mfa: false, now: t0 });
    const second = await sessions.rotateSession(first.refreshToken, new Date(t0.getTime() + 60_000));
    expect(second.outcome).toBe("ok");
    // A minute later the first token turns up again: a copy was taken.
    const replay = await sessions.rotateSession(first.refreshToken, new Date(t0.getTime() + 120_000));
    expect(replay).toMatchObject({ outcome: "reuse", userId: user.id });
    // The thief's use also killed the legitimate holder's newer token.
    if (second.outcome === "ok") expect((await sessions.rotateSession(second.refreshToken, new Date(t0.getTime() + 130_000))).outcome).toBe("invalid");
  });

  it("keeps at most 20 devices signed in per account: the one unused longest is signed out", async () => {
    const user = await makeUser("viewer");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const all: Awaited<ReturnType<typeof sessions.createSession>>[] = [];
    for (let i = 0; i < 21; i++) all.push(await sessions.createSession({ userId: user.id, client: "app", mfa: false, now: new Date(t0.getTime() + i * 1000) }));
    const list = await sessions.listUserSessions(user.id, undefined, new Date(t0.getTime() + 60_000));
    expect(list).toHaveLength(20);
    expect(list.some((s) => s.id === all[0]!.session.id)).toBe(false);
  });

  it("names devices", () => {
    expect(sessions.describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/126 Safari/537 Edg/126", "web")).toBe("Edge · Windows");
    expect(sessions.describeDevice("Mozilla/5.0 (Linux; Android 14) Chrome/126 OneTrackApp", "app")).toBe("App OneTrack · Android");
    expect(sessions.describeDevice(undefined, "web")).toBe("Navegador");
  });
});

describe("the authenticator for admins", () => {
  it("makes an admin set one up before it gets in: the first login hands out no session", async () => {
    const admin = await makeUser("admin");
    const res = await login(admin.email);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.mfaSetupRequired).toBe(true);
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("refreshToken");
    // And the owner of an account is an admin too.
    expect((await login((await makeUser("owner")).email)).json().mfaSetupRequired).toBe(true);
  });

  it("opens the session and hands over 10 single-use recovery codes when the first code is right", async () => {
    const admin = await makeUser("admin");
    const { session } = await enrollAdmin(admin.email);
    expect(session.recoveryCodes).toHaveLength(10);
    for (const code of session.recoveryCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect((await get("/auth/sessions", session.token)).statusCode).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row!.totpEnabledAt).not.toBeNull();
  });

  it("keeps the secret encrypted at rest and the recovery codes only as hashes", async () => {
    const admin = await makeUser("admin");
    const { secret, session } = await enrollAdmin(admin.email);
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row!.totpSecretEnc).toMatch(/^k[12]\./);
    expect(row!.totpSecretEnc).not.toContain(secret);
    const stored = await db.select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, admin.id));
    expect(stored).toHaveLength(10);
    for (const code of session.recoveryCodes) expect(JSON.stringify(stored)).not.toContain(code.replace("-", ""));
  });

  it("refuses to confirm setup with a wrong code", async () => {
    const admin = await makeUser("admin");
    const first = (await login(admin.email)).json();
    await post("/auth/login/totp/setup", { mfaToken: first.mfaToken });
    const res = await post("/auth/login/totp/enable", { mfaToken: first.mfaToken, code: "000000" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty("token");
  });

  it("asks for the code at every later sign-in, and gives a session only for the right one", async () => {
    const admin = await makeUser("admin");
    const { secret } = await enrollAdmin(admin.email);
    const step = totpStep(Date.now());

    const second = (await login(admin.email)).json();
    expect(second.mfaRequired).toBe(true);
    expect(second).not.toHaveProperty("token");

    const wrong = await post("/auth/login/totp", { mfaToken: second.mfaToken, code: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(alerts.recordLoginFailure).toHaveBeenCalledWith(admin.email);

    // The enrolment used this step's code; the next one is what the app shows 30 seconds on (the window accepts it).
    const next = hotp(secret, step + 1);
    const ok = await post("/auth/login/totp", { mfaToken: second.mfaToken, code: next });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty("refreshToken");
    expect(ok.json().usedRecoveryCode).toBe(false);
    expect((await sessions.listUserSessions(admin.id)).some((s) => s.mfa)).toBe(true);
  });

  it("never accepts the same code twice", async () => {
    const admin = await makeUser("admin");
    const { secret } = await enrollAdmin(admin.email);
    const code = hotp(secret, totpStep(Date.now()) + 1);
    const a = (await login(admin.email)).json();
    expect((await post("/auth/login/totp", { mfaToken: a.mfaToken, code })).statusCode).toBe(200);
    const b = (await login(admin.email)).json();
    expect((await post("/auth/login/totp", { mfaToken: b.mfaToken, code })).statusCode).toBe(401);
    // The enrolment's own code can't be replayed either.
    expect((await post("/auth/login/totp", { mfaToken: b.mfaToken, code: hotp(secret, totpStep(Date.now())) })).statusCode).toBe(401);
  });

  it("takes a recovery code in place of the app's, once", async () => {
    const admin = await makeUser("admin");
    const { session } = await enrollAdmin(admin.email);
    const recoveryCode = session.recoveryCodes[0]!;
    const a = (await login(admin.email)).json();
    const ok = await post("/auth/login/totp", { mfaToken: a.mfaToken, recoveryCode: recoveryCode.toLowerCase().replace("-", " ") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ usedRecoveryCode: true, recoveryCodesLeft: 9 });
    const b = (await login(admin.email)).json();
    expect((await post("/auth/login/totp", { mfaToken: b.mfaToken, recoveryCode })).statusCode).toBe(401);
  });

  it("is not fooled by the notes handed out between the steps being used as login tokens", async () => {
    const admin = await makeUser("admin");
    const setupNote = (await login(admin.email)).json().mfaToken as string;
    expect((await get("/auth/sessions", setupNote)).statusCode).toBe(401);
    expect((await get("/me", setupNote)).statusCode).toBe(401);
    // …nor one step's note used for the other step
    expect((await post("/auth/login/totp", { mfaToken: setupNote, code: "123456" })).statusCode).toBe(401);
    const enrolled = await makeUser("admin");
    await enrollAdmin(enrolled.email);
    const second = (await login(enrolled.email)).json();
    expect(second.mfaRequired).toBe(true);
    expect((await post("/auth/login/totp/setup", { mfaToken: second.mfaToken })).statusCode).toBe(401);
    // …and a login token is no note at all
    const viewer = await signIn((await makeUser("viewer")).email);
    expect((await post("/auth/login/totp", { mfaToken: viewer.token, code: "123456" })).statusCode).toBe(401);
  });

  it("brakes guessing the code: 10 tries per account, then 429", async () => {
    const admin = await makeUser("admin");
    await enrollAdmin(admin.email);
    resetSecondFactorLimits(); // setting it up counted as an attempt too
    const note = (await login(admin.email)).json().mfaToken as string;
    for (let i = 0; i < SECOND_FACTOR_LIMITS.perUser; i++) {
      expect((await post("/auth/login/totp", { mfaToken: note, code: "000000" })).statusCode).toBe(401);
    }
    const blocked = await post("/auth/login/totp", { mfaToken: note, code: "000000" });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not let an admin turn it off (the rule is for their role, so the app hides the option too)", async () => {
    const admin = await makeUser("admin");
    const { secret, session } = await enrollAdmin(admin.email);
    const res = await post("/auth/totp/disable", { password: PASSWORD, code: hotp(secret, totpStep(Date.now()) + 1) }, bearer(session.token));
    expect(res.statusCode).toBe(403);
  });
});

describe("the authenticator for everyone else (optional)", () => {
  it("lets a viewer sign in with just the password, and shows it is not required", async () => {
    const viewer = await makeUser("viewer");
    const session = await signIn(viewer.email);
    expect((await get("/auth/security", session.token)).json()).toEqual({ enabled: false, required: false, secondStepRequired: false, emailCodes: false, recoveryCodesLeft: 0 });
  });

  it("can be turned on from the app and then asks for the code at the next sign-in", async () => {
    const viewer = await makeUser("viewer");
    const session = await signIn(viewer.email);
    const setup = (await post("/auth/totp/setup", {}, bearer(session.token))).json() as { secret: string };
    expect((await post("/auth/totp/enable", { code: "000000" }, bearer(session.token))).statusCode).toBe(400);
    const enabled = await post("/auth/totp/enable", { code: hotp(setup.secret, totpStep(Date.now())) }, bearer(session.token));
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().recoveryCodes).toHaveLength(10);
    expect((await get("/auth/security", session.token)).json()).toEqual({ enabled: true, required: false, secondStepRequired: true, emailCodes: false, recoveryCodesLeft: 10 });
    expect((await login(viewer.email)).json().mfaRequired).toBe(true);
    // turning it on again is refused: it is already on
    expect((await post("/auth/totp/setup", {}, bearer(session.token))).statusCode).toBe(409);
  });

  it("is turned off only with the password and a code, and signs out the other devices", async () => {
    const viewer = await makeUser("viewer");
    const phone = await signIn(viewer.email);
    const laptop = await signIn(viewer.email);
    const setup = (await post("/auth/totp/setup", {}, bearer(phone.token))).json() as { secret: string };
    await post("/auth/totp/enable", { code: hotp(setup.secret, totpStep(Date.now())) }, bearer(phone.token));

    expect((await post("/auth/totp/disable", { password: "wrong-password", code: hotp(setup.secret, totpStep(Date.now()) + 1) }, bearer(phone.token))).statusCode).toBe(403);
    expect((await post("/auth/totp/disable", { password: PASSWORD, code: "000000" }, bearer(phone.token))).statusCode).toBe(403);
    const off = await post("/auth/totp/disable", { password: PASSWORD, code: hotp(setup.secret, totpStep(Date.now()) + 1) }, bearer(phone.token));
    expect(off.statusCode).toBe(204);
    expect((await get("/auth/sessions", laptop.token)).statusCode).toBe(401);
    expect((await get("/auth/security", phone.token)).json().enabled).toBe(false);
    expect((await login(viewer.email)).json()).toHaveProperty("token");
    expect(await db.select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, viewer.id))).toHaveLength(0);
  });

  it("makes new recovery codes (the old ones stop working) after asking for the password and a code", async () => {
    const viewer = await makeUser("viewer");
    const session = await signIn(viewer.email);
    const setup = (await post("/auth/totp/setup", {}, bearer(session.token))).json() as { secret: string };
    const first = (await post("/auth/totp/enable", { code: hotp(setup.secret, totpStep(Date.now())) }, bearer(session.token))).json() as { recoveryCodes: string[] };
    const res = await post("/auth/totp/recovery-codes", { password: PASSWORD, code: hotp(setup.secret, totpStep(Date.now()) + 1) }, bearer(session.token));
    expect(res.statusCode).toBe(200);
    const fresh = (res.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.filter((code) => first.recoveryCodes.includes(code))).toHaveLength(0);
    const note = (await login(viewer.email)).json().mfaToken as string;
    expect((await post("/auth/login/totp", { mfaToken: note, recoveryCode: first.recoveryCodes[0] })).statusCode).toBe(401);
    expect((await post("/auth/login/totp", { mfaToken: note, recoveryCode: fresh[0] })).statusCode).toBe(200);
  });
});

describe("resetting a lost authenticator", () => {
  it("lets the owner remove an admin's, which also signs the admin out everywhere", async () => {
    const owner = await makeUser("owner");
    const ownerSession = (await enrollAdmin(owner.email)).session;
    const admin = await makeUser("admin");
    const adminSession = (await enrollAdmin(admin.email)).session;

    const res = await post(`/users/${admin.id}/totp/reset`, {}, bearer(ownerSession.token));
    expect(res.statusCode).toBe(204);
    expect((await get("/auth/sessions", adminSession.token)).statusCode).toBe(401);
    // the admin is made to set a new one up at the next sign-in
    expect((await login(admin.email)).json().mfaSetupRequired).toBe(true);
  });

  it("does not let an admin reset another admin's, nor anyone reset their own or the owner's", async () => {
    const owner = await makeUser("owner");
    await enrollAdmin(owner.email);
    const adminA = await makeUser("admin");
    const a = (await enrollAdmin(adminA.email)).session;
    const adminB = await makeUser("admin");
    await enrollAdmin(adminB.email);

    expect((await post(`/users/${adminB.id}/totp/reset`, {}, bearer(a.token))).statusCode).toBe(403);
    expect((await post(`/users/${adminA.id}/totp/reset`, {}, bearer(a.token))).statusCode).toBe(403);
    expect((await post(`/users/${owner.id}/totp/reset`, {}, bearer(a.token))).statusCode).toBe(403);
  });

  it("lets an admin reset a viewer's, who then signs in with just the password", async () => {
    const admin = await makeUser("admin");
    const a = (await enrollAdmin(admin.email)).session;
    const viewer = await makeUser("viewer");
    const v = await signIn(viewer.email);
    const setup = (await post("/auth/totp/setup", {}, bearer(v.token))).json() as { secret: string };
    await post("/auth/totp/enable", { code: hotp(setup.secret, totpStep(Date.now())) }, bearer(v.token));
    expect((await login(viewer.email)).json().mfaRequired).toBe(true);

    expect((await post(`/users/${viewer.id}/totp/reset`, {}, bearer(a.token))).statusCode).toBe(204);
    expect((await login(viewer.email)).json()).toHaveProperty("token");
  });

  it("refuses a viewer trying to reset anyone's", async () => {
    const viewer = await signIn((await makeUser("viewer")).email);
    const other = await makeUser("viewer");
    expect((await post(`/users/${other.id}/totp/reset`, {}, bearer(viewer.token))).statusCode).toBe(403);
  });
});
