import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** A phone only receives its person's notifications while the sign-in it registered under is open. */
vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});
vi.mock("../../src/config/env.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env.js")>();
  const key = JSON.stringify({ project_id: "p", client_email: "e@p.iam", private_key: "k" });
  return { ...original, env: { ...original.env, FIREBASE_SERVICE_ACCOUNT_JSON: key } };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getAccessToken = async () => "bearer"; } }));

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const schema = await import("../../src/db/schema/index.js");
const { saveToken, sendPushToUsers } = await import("../../src/services/push.service.js");
const { db } = clientModule;

const MESSAGE = { title: "t", body: "b" };
const HOUR = 3_600_000;
let org: string;
let ana: string;
let bruno: string;
let delivered: string[];

beforeAll(async () => {
  await clientModule.__pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text, plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer', parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'it', totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE user_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, refresh_hash varchar(64) NOT NULL, previous_hash varchar(64), rotated_at timestamptz, client varchar(10) NOT NULL DEFAULT 'web', mfa boolean NOT NULL DEFAULT false, device varchar(120) NOT NULL DEFAULT '', ip varchar(45), created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE push_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, token text NOT NULL UNIQUE, session_id uuid REFERENCES user_sessions(id) ON DELETE CASCADE, platform varchar(20) NOT NULL DEFAULT 'android', created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now());
  `);
  const [o] = await db.insert(schema.organizations).values({ name: "Gamonal" }).returning();
  org = o!.id;
  const [a] = await db.insert(schema.users).values({ orgId: org, email: "ana@x.it", passwordHash: "x", role: "viewer" }).returning();
  const [b] = await db.insert(schema.users).values({ orgId: org, email: "bruno@x.it", passwordHash: "x", role: "viewer" }).returning();
  ana = a!.id;
  bruno = b!.id;
});
afterAll(async () => {
  await clientModule.__pg.close();
});
beforeEach(async () => {
  await db.delete(schema.pushTokens);
  await db.delete(schema.userSessions);
  delivered = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      delivered.push((JSON.parse(init.body) as { message: { token: string } }).message.token);
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
});

async function session(userId: string, over: Partial<typeof schema.userSessions.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.userSessions)
    .values({ userId, refreshHash: "h", client: "app", expiresAt: new Date(Date.now() + HOUR), absoluteExpiresAt: new Date(Date.now() + 24 * HOUR), ...over })
    .returning();
  return row!.id;
}
const remaining = async () => (await db.select().from(schema.pushTokens)).map((row) => row.token).sort();

describe("which phones receive a person's notifications", () => {
  it("sends to a phone whose session is open", async () => {
    await saveToken(ana, org, "phone-ana", "android", await session(ana));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(1);
    expect(delivered).toEqual(["phone-ana"]);
  });

  it("does not send to a phone whose session was signed out, and forgets it", async () => {
    await saveToken(ana, org, "phone-ana", "android", await session(ana, { revokedAt: new Date() }));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(0);
    expect(delivered).toEqual([]);
    expect(await remaining()).toEqual([]);
  });

  it("does not send to a phone whose session expired (idle or absolute)", async () => {
    await saveToken(ana, org, "idle", "android", await session(ana, { expiresAt: new Date(Date.now() - 1000) }));
    await saveToken(ana, org, "absolute", "android", await session(ana, { absoluteExpiresAt: new Date(Date.now() - 1000) }));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(0);
    expect(delivered).toEqual([]);
  });

  it("does not send to an old phone that carries no session", async () => {
    await clientModule.__pg.query(`INSERT INTO push_tokens (user_id, org_id, token) VALUES ('${ana}', '${org}', 'legacy')`);
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(0);
    expect(delivered).toEqual([]);
  });

  it("keeps one person's notifications off another person's phone, and a shared phone follows whoever signed in last", async () => {
    await saveToken(ana, org, "shared-phone", "android", await session(ana));
    await saveToken(bruno, org, "bruno-phone", "android", await session(bruno));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(1);
    expect(delivered).toEqual(["shared-phone"]);

    delivered = [];
    // Bruno signs in on Ana's phone: it is his from now on, even though Ana's own session is still open elsewhere.
    await saveToken(bruno, org, "shared-phone", "android", await session(bruno));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(0);
    expect(delivered).toEqual([]);
    expect(await sendPushToUsers([bruno], MESSAGE)).toBe(2);
  });

  it("a session ending only affects its own phone", async () => {
    const mine = await session(ana);
    await saveToken(ana, org, "ana-1", "android", mine);
    await saveToken(ana, org, "ana-2", "android", await session(ana));
    await db.update(schema.userSessions).set({ revokedAt: new Date() }).where((await import("drizzle-orm")).eq(schema.userSessions.id, mine));
    expect(await sendPushToUsers([ana], MESSAGE)).toBe(1);
    expect(delivered).toEqual(["ana-2"]);
    expect(await remaining()).toEqual(["ana-2"]);
  });
});
