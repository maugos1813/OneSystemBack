import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** A live connection lives as long as its session, not as long as the 15-minute login token (each reconnection costs a full snapshot). */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { registerRealtimeGateway } = await import("../../src/realtime/gateway.js");
const { ACCESS_TOKEN_TTL } = await import("../../src/services/userSession.service.js");
const sessions = await import("../../src/services/userSession.service.js");
const schema = await import("../../src/db/schema/index.js");
const { db } = clientModule;

let app: ReturnType<typeof Fastify> & { injectWS: (path: string) => Promise<{ readyState: number; terminate: () => void }> };
let userId: string;
const ORG = "00000000-0000-0000-0000-00000000f001";

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text, plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer', parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'es', totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_hash varchar(64) NOT NULL, previous_hash varchar(64), rotated_at timestamptz, client varchar(10) NOT NULL DEFAULT 'web', mfa boolean NOT NULL DEFAULT false, device varchar(120) NOT NULL DEFAULT '', ip varchar(45), created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz);
  `);
  const [org] = await db.insert(schema.organizations).values({ name: "Gamonal" }).returning();
  const [user] = await db.insert(schema.users).values({ orgId: org!.id, email: "v@x.it", passwordHash: "x", role: "viewer" }).returning();
  userId = user!.id;
  // Only the gateway, registered on the instance itself (inside buildApp it sits in an encapsulated plugin, out of injectWS's reach).
  const instance = Fastify();
  await instance.register(jwt, { secret: process.env.JWT_SECRET!, sign: { expiresIn: ACCESS_TOKEN_TTL } });
  await registerRealtimeGateway(instance);
  await instance.ready();
  app = instance as unknown as typeof app;
});
afterAll(async () => {
  await app.close();
  await clientModule.__pg.close();
});
afterEach(() => {
  vi.useRealTimers();
  sessions.forgetRevokedSessions();
});

const MINUTE = 60_000;
const closed = (ws: { readyState: number }) => ws.readyState === 3 /* CLOSED */ || ws.readyState === 2; /* CLOSING */

async function connect(token: string) {
  const ws = await app.injectWS(`/realtime/positions?token=${token}`);
  return ws;
}
async function loginToken() {
  const { session } = await sessions.createSession({ userId, client: "web", mfa: false });
  return { sessionId: session.id, token: app.jwt.sign({ userId, orgId: ORG, role: "viewer", allowedArea: null, sid: session.id }) };
}

describe("how long a live connection lasts", () => {
  it("stays open past the 15 minutes of the login token that opened it", async () => {
    const { token } = await loginToken();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const ws = await connect(token);
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    expect(closed(ws)).toBe(false);
    ws.terminate();
  });

  it("ends when its session is signed out, within seconds", async () => {
    const { token, sessionId } = await loginToken();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const ws = await connect(token);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closed(ws)).toBe(false);
    await sessions.revokeUserSession(userId, sessionId);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(closed(ws)).toBe(true);
  });

  it("ends after 8 hours even if the session lives on (the client reconnects with a fresh login)", async () => {
    const { token } = await loginToken();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const ws = await connect(token);
    await vi.advanceTimersByTimeAsync(7 * 60 * MINUTE);
    expect(closed(ws)).toBe(false);
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    expect(closed(ws)).toBe(true);
  });

  it("still ends a token with no session (the two-hour view of a client) when the token ends", async () => {
    const token = app.jwt.sign({ userId, orgId: ORG, role: "admin", allowedArea: null, viewAs: true }, { expiresIn: "2h" });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const ws = await connect(token);
    await vi.advanceTimersByTimeAsync(119 * MINUTE);
    expect(closed(ws)).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(closed(ws)).toBe(true);
  });

  it("refuses a token whose session was already signed out", async () => {
    const { token, sessionId } = await loginToken();
    await sessions.revokeUserSession(userId, sessionId);
    const ws = await connect(token);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed(ws)).toBe(true);
  });
});
