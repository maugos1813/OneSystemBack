import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Signing in from a phone: the second step is a 6-digit code sent to the account's email (a computer keeps the QR and the authenticator). */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
const mail = vi.hoisted(() => ({ available: true, accepts: true, sent: [] as Array<{ to: string; code: string; language: string }> }));
vi.mock("../../src/services/email.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/email.service.js")>()),
  canEmailLoginCodes: () => mail.available,
  sendLoginCodeEmail: async (to: string, code: string, language: string) => {
    if (!mail.accepts) return false;
    mail.sent.push({ to, code, language });
    return true;
  },
}));
vi.mock("../../src/services/platformAlerts.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/platformAlerts.service.js")>()),
  recordLoginFailure: vi.fn(async () => undefined),
}));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const { hashPassword } = await import("../../src/services/auth.service.js");
const { encryptSecret } = await import("../../src/services/secretBox.js");
const { generateTotpSecret, hotp, totpStep } = await import("../../src/services/totp.js");
const { resetLoginLimits, resetSecondFactorLimits, SECOND_FACTOR_LIMITS } = await import("../../src/api/middlewares/loginRateLimit.js");
const codes = await import("../../src/services/emailCode.service.js");
const sessions = await import("../../src/services/userSession.service.js");
const schema = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

const PASSWORD = "a-long-password-1";
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let counter = 0;

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text, plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer', parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'es', totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_hash varchar(64) NOT NULL, previous_hash varchar(64), rotated_at timestamptz, client varchar(10) NOT NULL DEFAULT 'web', mfa boolean NOT NULL DEFAULT false, device varchar(120) NOT NULL DEFAULT '', ip varchar(45), created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE user_recovery_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash varchar(64) NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_email_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash varchar(64) NOT NULL, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz);
  `);
  const [org] = await db.insert(schema.organizations).values({ name: "Gamonal" }).returning();
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
  mail.available = true;
  mail.accepts = true;
  mail.sent.length = 0;
});

const passwordHash = await hashPassword(PASSWORD);
async function makeUser(role: "owner" | "admin" | "manager" | "viewer", extra: Partial<typeof schema.users.$inferInsert> = {}) {
  const [user] = await db.insert(schema.users).values({ orgId, email: `${role}${++counter}@x.it`, passwordHash, role, ...extra }).returning();
  return user!;
}
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress: "10.0.0.1" });
const login = (email: string, channel: "web" | "phone") => post("/auth/login", { email, password: PASSWORD, channel, client: channel === "phone" ? "app" : "web" });
const lastCode = () => mail.sent[mail.sent.length - 1]!.code;
/** An account that has the authenticator on (set up from a computer); returns its secret. */
async function withAuthenticator(userId: string): Promise<string> {
  const secret = generateTotpSecret();
  await db.update(schema.users).set({ totpSecretEnc: encryptSecret(secret), totpEnabledAt: new Date() }).where(eq(schema.users.id, userId));
  return secret;
}

describe("signing in from a phone", () => {
  it("sends an admin a code by email instead of asking for the authenticator, and hands out no session until it is typed", async () => {
    const admin = await makeUser("admin", { language: "it" });
    const res = await login(admin.email, "phone");
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ mfaRequired: true, method: "email", emailHint: expect.stringMatching(/^a•••@x\.it$/) });
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("mfaSetupRequired");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: admin.email, language: "it" });
    expect(mail.sent[0]!.code).toMatch(/^\d{6}$/);
  });

  it("opens the session with the right code, and keeps it open when it renews (an admin who never set up an authenticator stays in)", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    const ok = await post("/auth/login/email", { mfaToken: note, code: lastCode() });
    expect(ok.statusCode).toBe(200);
    const session = ok.json() as { token: string; refreshToken: string };
    expect(session).toHaveProperty("refreshToken");
    expect((await sessions.listUserSessions(admin.id))[0]!.mfa).toBe(true);
    const renewed = await post("/auth/refresh", { refreshToken: session.refreshToken });
    expect(renewed.statusCode).toBe(200);
  });

  it("does not ask a computer for an email code: it keeps the QR (the admin must set up the authenticator there)", async () => {
    const admin = await makeUser("admin");
    const res = await login(admin.email, "web");
    expect(res.json()).toHaveProperty("mfaSetupRequired", true);
    expect(mail.sent).toHaveLength(0);
  });

  it("falls back to the authenticator flow when email isn't set up, so nobody is locked out", async () => {
    mail.available = false;
    const admin = await makeUser("admin");
    expect((await login(admin.email, "phone")).json()).toHaveProperty("mfaSetupRequired", true);
    expect(mail.sent).toHaveLength(0);
  });

  it("lets a plain user in with just the password, as before (they have no second step)", async () => {
    const viewer = await makeUser("viewer");
    expect((await login(viewer.email, "phone")).json()).toHaveProperty("token");
    expect(mail.sent).toHaveLength(0);
  });

  it("sends the code to a user who turned the authenticator on, and offers the authenticator as an alternative", async () => {
    const viewer = await makeUser("viewer");
    const secret = await withAuthenticator(viewer.id);
    const body = (await login(viewer.email, "phone")).json();
    expect(body).toMatchObject({ method: "email" });
    expect(mail.sent).toHaveLength(1);
    const alt = await post("/auth/login/totp", { mfaToken: body.alternativeMfaToken, code: hotp(secret, totpStep(Date.now())) });
    expect(alt.statusCode).toBe(200);
  });

  it("uses the authenticator when the email could not be sent, if the account has one", async () => {
    mail.accepts = false;
    const viewer = await makeUser("viewer");
    await withAuthenticator(viewer.id);
    const body = (await login(viewer.email, "phone")).json();
    expect(body).toHaveProperty("mfaRequired", true);
    expect(body).not.toHaveProperty("method");
  });

  it("answers 503, not a session, when the email can't be sent and there is no authenticator to fall back on", async () => {
    mail.accepts = false;
    const admin = await makeUser("admin");
    const res = await login(admin.email, "phone");
    expect(res.statusCode).toBe(503);
    expect(res.json()).not.toHaveProperty("token");
  });
});

describe("the emailed code", () => {
  it("is refused when wrong, and the real one still works afterwards", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    expect((await post("/auth/login/email", { mfaToken: note, code: wrong })).statusCode).toBe(401);
    expect((await post("/auth/login/email", { mfaToken: note, code: lastCode() })).statusCode).toBe(200);
  });

  it("works only once", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    const code = lastCode();
    expect((await post("/auth/login/email", { mfaToken: note, code })).statusCode).toBe(200);
    expect((await post("/auth/login/email", { mfaToken: note, code })).statusCode).toBe(401);
  });

  it("dies after five wrong tries, even for the right code", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    const real = lastCode();
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < codes.EMAIL_CODE_MAX_ATTEMPTS; i++) expect((await post("/auth/login/email", { mfaToken: note, code: wrong })).statusCode).toBe(401);
    expect((await post("/auth/login/email", { mfaToken: note, code: real })).statusCode).toBe(401);
  });

  it("expires after ten minutes", async () => {
    const admin = await makeUser("admin");
    const t0 = new Date("2026-01-01T10:00:00Z");
    await codes.issueEmailCode({ id: admin.id, email: admin.email, language: "es" }, t0);
    const code = lastCode();
    expect(await codes.verifyEmailCode(admin.id, code, new Date(t0.getTime() + 11 * 60_000))).toBe(false);
    await codes.issueEmailCode({ id: admin.id, email: admin.email, language: "es" }, new Date(t0.getTime() + 20 * 60_000));
    expect(await codes.verifyEmailCode(admin.id, lastCode(), new Date(t0.getTime() + 25 * 60_000))).toBe(true);
  });

  it("is replaced by a newer one: only the last code sent works", async () => {
    const admin = await makeUser("admin");
    const t0 = new Date("2026-01-01T10:00:00Z");
    const user = { id: admin.id, email: admin.email, language: "es" as const };
    await codes.issueEmailCode(user, t0);
    const first = lastCode();
    await codes.issueEmailCode(user, new Date(t0.getTime() + 40_000));
    const second = lastCode();
    expect(await codes.verifyEmailCode(admin.id, first, new Date(t0.getTime() + 50_000))).toBe(first === second);
    expect(await codes.verifyEmailCode(admin.id, second, new Date(t0.getTime() + 50_000))).toBe(true);
  });

  it("is kept only as a keyed hash, never in the clear", async () => {
    const admin = await makeUser("admin");
    await login(admin.email, "phone");
    const rows = await db.select().from(schema.userEmailCodes).where(eq(schema.userEmailCodes.userId, admin.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(lastCode());
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("brakes guessing across tries and logins: 10 per account per 15 minutes, then 429", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    for (let i = 0; i < SECOND_FACTOR_LIMITS.perUser; i++) await post("/auth/login/email", { mfaToken: note, code: "123456" });
    expect((await post("/auth/login/email", { mfaToken: note, code: lastCode() })).statusCode).toBe(429);
  });

  it("is not accepted by the authenticator step, and its note is no login token", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    expect((await post("/auth/login/totp", { mfaToken: note, code: lastCode() })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/auth/sessions", headers: { authorization: `Bearer ${note}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe("asking for the code again", () => {
  it("is refused for 30 seconds after a send, so a double tap doesn't flood the mailbox", async () => {
    const admin = await makeUser("admin");
    const note = (await login(admin.email, "phone")).json().mfaToken as string;
    const res = await post("/auth/login/email/resend", { mfaToken: note });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(1);
  });

  it("sends a fresh code once the wait is over, and no more than five an hour", async () => {
    const admin = await makeUser("admin");
    const user = { id: admin.id, email: admin.email, language: "es" as const };
    const t0 = new Date("2026-01-01T10:00:00Z");
    for (let i = 0; i < codes.EMAIL_CODE_MAX_PER_HOUR; i++) {
      expect((await codes.issueEmailCode(user, new Date(t0.getTime() + i * 40_000))).outcome).toBe("sent");
    }
    expect((await codes.issueEmailCode(user, new Date(t0.getTime() + 6 * 40_000))).outcome).toBe("limit");
    expect((await codes.issueEmailCode(user, new Date(t0.getTime() + 61 * 60_000))).outcome).toBe("sent");
  });

  it("does not count a code that was never delivered", async () => {
    const admin = await makeUser("admin");
    mail.accepts = false;
    const user = { id: admin.id, email: admin.email, language: "es" as const };
    expect((await codes.issueEmailCode(user)).outcome).toBe("failed");
    mail.accepts = true;
    expect((await codes.issueEmailCode(user)).outcome).toBe("sent");
  });

  it("hides most of the address", () => {
    expect(codes.maskEmail("ana.perez@gmail.com")).toBe("a•••@gmail.com");
  });
});
