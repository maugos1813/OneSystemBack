import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** "Enter with the phone", WhatsApp Web style: the computer shows a QR, a phone that is signed in authorizes it. */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const { hashPassword } = await import("../../src/services/auth.service.js");
const { resetQrLimits, QR_LIMITS } = await import("../../src/api/middlewares/loginRateLimit.js");
const qr = await import("../../src/services/qrLogin.service.js");
const sessions = await import("../../src/services/userSession.service.js");
const schema = await import("../../src/db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { db } = clientModule;

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
let counter = 0;

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text, plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer', parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'es', totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_hash varchar(64) NOT NULL, previous_hash varchar(64), rotated_at timestamptz, client varchar(10) NOT NULL DEFAULT 'web', mfa boolean NOT NULL DEFAULT false, device varchar(120) NOT NULL DEFAULT '', ip varchar(45), created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE qr_login_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), secret_hash varchar(64) NOT NULL, user_agent varchar(300) NOT NULL DEFAULT '', device varchar(120) NOT NULL DEFAULT '', ip varchar(45), status varchar(10) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, approved_user_id uuid REFERENCES users(id) ON DELETE CASCADE, approved_mfa boolean NOT NULL DEFAULT false, approved_at timestamptz, claimed_at timestamptz);
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
  resetQrLimits();
  sessions.forgetRevokedSessions();
});

const passwordHash = await hashPassword("a-long-password-1");
async function makeUser(role: "owner" | "admin" | "manager" | "viewer") {
  const [user] = await db.insert(schema.users).values({ orgId, email: `${role}${++counter}@x.it`, passwordHash, role }).returning();
  return user!;
}

/** A phone app signed in as this user (mfa: whether its own sign-in passed a second step); returns the headers it would send. */
async function phoneOf(user: Awaited<ReturnType<typeof makeUser>>, opts: { mfa: boolean; client?: "app" | "web" }) {
  const { session } = await sessions.createSession({ userId: user.id, client: opts.client ?? "app", mfa: opts.mfa });
  const token = app.jwt.sign({ userId: user.id, orgId, role: user.role, allowedArea: null, sid: session.id });
  return { headers: { authorization: `Bearer ${token}` }, sessionId: session.id };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress: "10.0.0.1" });
const startOnComputer = async () => (await post("/auth/qr/start", {}, { "user-agent": CHROME_MAC })).json() as { code: string; expiresInSec: number };
const poll = (code: string) => post("/auth/qr/poll", { code });

describe("entering with the phone", () => {
  it("lets a signed-in phone open the computer: the computer then gets its own session, once", async () => {
    const viewer = await makeUser("viewer");
    const phone = await phoneOf(viewer, { mfa: false });
    const { code, expiresInSec } = await startOnComputer();
    expect(expiresInSec).toBe(120);
    expect((await poll(code)).json()).toEqual({ status: "pending" });

    const info = (await post("/auth/qr/inspect", { code }, phone.headers)).json() as { device: string };
    expect(info.device).toBe("Chrome · macOS");
    expect((await post("/auth/qr/approve", { code }, phone.headers)).statusCode).toBe(204);

    const got = (await poll(code)).json() as { status: string; token: string; refreshToken: string; sessionId: string };
    expect(got.status).toBe("approved");
    expect(got.token).toBeTruthy();
    expect((await app.inject({ method: "GET", url: "/auth/sessions", headers: { authorization: `Bearer ${got.token}` } })).statusCode).toBe(200);
    // the session belongs to the computer (Chrome, a browser session), not to the phone
    const list = await sessions.listUserSessions(viewer.id);
    const web = list.find((s) => s.id === got.sessionId)!;
    expect(web).toMatchObject({ client: "web", device: "Chrome · macOS" });
    expect(list).toHaveLength(2);
    // and it can be handed over only once
    expect((await poll(code)).json()).toEqual({ status: "expired" });
    expect((await post("/auth/refresh", { refreshToken: got.refreshToken })).statusCode).toBe(200);
  });

  it("gives an admin's computer a session that has passed the second step (it inherits the phone's)", async () => {
    const admin = await makeUser("admin");
    const phone = await phoneOf(admin, { mfa: true });
    const { code } = await startOnComputer();
    await post("/auth/qr/approve", { code }, phone.headers);
    const got = (await poll(code)).json() as { token: string; refreshToken: string; sessionId: string };
    expect((await sessions.listUserSessions(admin.id)).find((s) => s.id === got.sessionId)!.mfa).toBe(true);
    // an admin session must keep renewing: that is what the mfa flag is for
    expect((await post("/auth/refresh", { refreshToken: got.refreshToken })).statusCode).toBe(200);
  });

  it("refuses a phone whose own sign-in never passed the second step its account needs", async () => {
    const admin = await makeUser("admin");
    const phone = await phoneOf(admin, { mfa: false });
    const { code } = await startOnComputer();
    const res = await post("/auth/qr/approve", { code }, phone.headers);
    expect(res.statusCode).toBe(403);
    expect((await poll(code)).json()).toEqual({ status: "pending" });
  });

  it("refuses to be authorized from another computer: only the phone app can", async () => {
    const viewer = await makeUser("viewer");
    const browser = await phoneOf(viewer, { mfa: false, client: "web" });
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/approve", { code }, browser.headers)).statusCode).toBe(403);
  });

  it("refuses a token that has no session behind it", async () => {
    const viewer = await makeUser("viewer");
    const token = app.jwt.sign({ userId: viewer.id, orgId, role: "viewer", allowedArea: null });
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/approve", { code }, { authorization: `Bearer ${token}` })).statusCode).toBe(403);
  });

  it("does not let anyone approve without being signed in", async () => {
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/approve", { code })).statusCode).toBe(401);
    expect((await post("/auth/qr/inspect", { code })).statusCode).toBe(401);
  });

  it("refuses a phone whose session was ended", async () => {
    const viewer = await makeUser("viewer");
    const phone = await phoneOf(viewer, { mfa: false });
    await sessions.revokeAllUserSessions(viewer.id);
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/approve", { code }, phone.headers)).statusCode).toBe(401);
  });

  it("tells the computer when the phone said no", async () => {
    const viewer = await makeUser("viewer");
    const phone = await phoneOf(viewer, { mfa: false });
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/deny", { code }, phone.headers)).statusCode).toBe(204);
    expect((await poll(code)).json()).toEqual({ status: "denied" });
    expect((await post("/auth/qr/approve", { code }, phone.headers)).statusCode).toBe(404);
  });

  it("lets only the first approval win", async () => {
    const a = await phoneOf(await makeUser("viewer"), { mfa: false });
    const b = await phoneOf(await makeUser("viewer"), { mfa: false });
    const { code } = await startOnComputer();
    expect((await post("/auth/qr/approve", { code }, a.headers)).statusCode).toBe(204);
    expect((await post("/auth/qr/approve", { code }, b.headers)).statusCode).toBe(404);
  });

  it("does not know codes it didn't make, or ones with a wrong secret", async () => {
    const viewer = await makeUser("viewer");
    const phone = await phoneOf(viewer, { mfa: false });
    const { code } = await startOnComputer();
    const id = code.split(".")[0];
    for (const bad of ["nonsense-nonsense", `${id}.wrong-secret`, `${id}`, `00000000-0000-4000-8000-000000000000.${code.split(".")[1]}`, `${code}.extra`]) {
      expect((await post("/auth/qr/inspect", { code: bad }, phone.headers)).statusCode).toBe(404);
      expect((await post("/auth/qr/approve", { code: bad }, phone.headers)).statusCode).toBe(404);
      expect((await poll(bad)).json()).toEqual({ status: "expired" });
    }
  });

  it("keeps only a hash of the secret", async () => {
    const { code } = await startOnComputer();
    const rows = await db.select().from(schema.qrLoginRequests).where(eq(schema.qrLoginRequests.id, code.split(".")[0]!));
    expect(JSON.stringify(rows)).not.toContain(code.split(".")[1]!);
    expect(rows[0]!.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("brakes asking for QRs: 20 a minute per address", async () => {
    for (let i = 0; i < QR_LIMITS.startPerAddress; i++) expect((await post("/auth/qr/start", {})).statusCode).toBe(200);
    expect((await post("/auth/qr/start", {})).statusCode).toBe(429);
  });
});

describe("the clock", () => {
  it("expires a QR after two minutes, for scanning and for approving", async () => {
    const viewer = await makeUser("viewer");
    const t0 = new Date("2026-01-01T10:00:00Z");
    const { code } = await qr.startQrLogin({ userAgent: CHROME_MAC, now: t0 });
    expect(await qr.inspectQrLogin(code, new Date(t0.getTime() + 119_000))).not.toBeNull();
    expect(await qr.inspectQrLogin(code, new Date(t0.getTime() + 121_000))).toBeNull();
    expect(await qr.approveQrLogin(code, { userId: viewer.id, mfa: false }, new Date(t0.getTime() + 121_000))).toBe("invalid");
    expect(await qr.claimQrLogin(code, new Date(t0.getTime() + 121_000))).toEqual({ status: "expired" });
  });

  it("gives the computer a minute to collect an approval, no more", async () => {
    const viewer = await makeUser("viewer");
    const t0 = new Date("2026-01-01T10:00:00Z");
    const { code } = await qr.startQrLogin({ userAgent: CHROME_MAC, now: t0 });
    await qr.approveQrLogin(code, { userId: viewer.id, mfa: false }, new Date(t0.getTime() + 100_000));
    expect(await qr.claimQrLogin(code, new Date(t0.getTime() + 100_000 + 61_000))).toEqual({ status: "expired" });
    const second = await qr.startQrLogin({ userAgent: CHROME_MAC, now: t0 });
    await qr.approveQrLogin(second.code, { userId: viewer.id, mfa: false }, new Date(t0.getTime() + 100_000));
    expect((await qr.claimQrLogin(second.code, new Date(t0.getTime() + 100_000 + 30_000))).status).toBe("approved");
  });

  it("sweeps requests older than an hour", async () => {
    const t0 = new Date("2026-01-01T10:00:00Z");
    const old = await qr.startQrLogin({ now: t0 });
    await qr.startQrLogin({ now: new Date(t0.getTime() + 2 * 3_600_000) });
    const rows = await db.select().from(schema.qrLoginRequests).where(eq(schema.qrLoginRequests.id, old.code.split(".")[0]!));
    expect(rows).toHaveLength(0);
  });
});
