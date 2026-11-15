import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** "Sign in with OneTrack" end to end against an in-memory Postgres, with the real migration. */

process.env.PLATFORM_ADMIN_EMAILS = "plat@x.it";

vi.mock("../../src/db/client.js", async () => {
  const schema = await import("../../src/db/schema/index.js");
  const pg = new PGlite();
  return { db: drizzle(pg, { schema }), pool: {}, __pg: pg };
});

const clientModule = (await import("../../src/db/client.js")) as unknown as { db: ReturnType<typeof drizzle>; __pg: PGlite };
const { buildApp } = await import("../../src/api/app.js");
const oauth = await import("../../src/services/oauth.service.js");
const pg = clientModule.__pg;

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_AREA = "00000000-0000-0000-0000-0000000000a2";
const USER_NOMAP = "00000000-0000-0000-0000-0000000000a3";
const USER_PLATFORM = "00000000-0000-0000-0000-0000000000c1";
const USER_B = "00000000-0000-0000-0000-0000000000b1";
const REDIRECT = "https://app-piazza.vercel.app/mapa/onetrack/oauth";
const REDIRECT_DEV = "http://localhost:5174/mapa/onetrack/oauth";
const ID = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let secret: string;
let otherSecret: string;

const b64u = (b: Buffer) => b.toString("base64url");
function pkcePair() {
  const verifier = b64u(randomBytes(48));
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
const bearer = (userId: string, orgId: string, role = "owner", allowedArea: string | null = null) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, orgId, role, allowedArea } as never)}`,
});
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

const authorizeQuery = (pair: { challenge: string }, extra: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: "app-piazza",
  redirect_uri: REDIRECT,
  scope: "vehicles:read",
  state: "st-123 &=?",
  code_challenge: pair.challenge,
  code_challenge_method: "S256",
  ...extra,
});

/** The whole consent step for a person, returning the code the app would receive. */
async function authorizeAs(headers: Record<string, string>, pair = pkcePair(), extra: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: "/oauth/authorize/decision", headers, payload: { ...authorizeQuery(pair, extra), decision: "approve" } });
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().redirectTo);
  return { pair, code: url.searchParams.get("code")!, url };
}
const tokenRequest = (data: Record<string, string>, clientSecret = secret) =>
  app.inject({ method: "POST", url: "/oauth/token", headers: FORM, payload: form({ client_id: "app-piazza", client_secret: clientSecret, ...data }) });
const exchange = (code: string, pair: { verifier: string }, extra: Record<string, string> = {}) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pair.verifier, ...extra });
const positions = (token: string) => app.inject({ method: "GET", url: "/oauth/fleet/live-positions", headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  await pg.exec(`
    CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
    CREATE TABLE organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, logo text, plan varchar(50) NOT NULL DEFAULT 'free', settings jsonb NOT NULL DEFAULT '{}', modules text[], logo_tag text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name varchar(100) NOT NULL DEFAULT '', email varchar(255) NOT NULL UNIQUE, password_hash varchar(255) NOT NULL, role user_role NOT NULL DEFAULT 'viewer', parent_user_id uuid, allowed_area varchar(50), logo text, modules text[], language varchar(5) NOT NULL DEFAULT 'es', totp_secret_enc text, totp_enabled_at timestamptz, totp_last_step integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE devices (id uuid PRIMARY KEY, org_id uuid, imei varchar(20) NOT NULL UNIQUE, model varchar(50) NOT NULL DEFAULT 'FMB204', serial_number varchar(32), firmware varchar(32), status varchar(20) NOT NULL DEFAULT 'active', source varchar(20) NOT NULL DEFAULT 'teltonika', last_seen_at timestamptz, green_driving_since timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE vehicles (id uuid PRIMARY KEY, org_id uuid NOT NULL, name varchar(100) NOT NULL, plate varchar(20), fleet_group varchar(50), device_id uuid, odometer_offset_km integer NOT NULL DEFAULT 0, brand varchar(50), model varchar(50), year integer, vin varchar(30), fuel_type varchar(20), color varchar(30), notes text, odometer_mode varchar(10) NOT NULL DEFAULT 'auto', odometer_base_km integer, odometer_base_at timestamptz, km_factor double precision NOT NULL DEFAULT 1, km_factor_at timestamptz, odometer_base_day_km double precision, out_of_service boolean NOT NULL DEFAULT false, out_of_service_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE positions (id uuid NOT NULL DEFAULT gen_random_uuid(), device_id uuid NOT NULL, ts timestamptz NOT NULL, lat double precision NOT NULL, lng double precision NOT NULL, altitude integer NOT NULL DEFAULT 0, angle integer NOT NULL DEFAULT 0, satellites smallint, speed integer NOT NULL DEFAULT 0, priority smallint NOT NULL DEFAULT 0, io_data jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (id, ts));
  `);
  // The REAL migration of the OAuth tables.
  for (const file of ["0048_oauth_provider", "0049_oauth_grant_vehicles"])
    for (const statement of readFileSync(`drizzle/${file}.sql`, "utf8").split("--> statement-breakpoint")) await pg.exec(statement);

  await pg.exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORG_A}', 'Gamonal Trasporti'), ('${ORG_B}', 'Altra Azienda');
    INSERT INTO users (id, org_id, email, password_hash, role, allowed_area, modules) VALUES
      ('${USER_A}', '${ORG_A}', 'a@x.it', 'x', 'owner', NULL, NULL),
      ('${USER_AREA}', '${ORG_A}', 'area@x.it', 'x', 'viewer', 'DHL', '{mapa,vehiculos}'),
      ('${USER_NOMAP}', '${ORG_A}', 'nomap@x.it', 'x', 'viewer', NULL, '{alertas}'),
      ('${USER_B}', '${ORG_B}', 'b@x.it', 'x', 'owner', NULL, NULL),
      ('${USER_PLATFORM}', '${ORG_B}', 'plat@x.it', 'x', 'owner', NULL, NULL);
    INSERT INTO devices (id, org_id, imei) VALUES
      ('${ID(1)}', '${ORG_A}', '350000000000001'), ('${ID(2)}', '${ORG_A}', '350000000000002'), ('${ID(3)}', '${ORG_A}', '350000000000003'),
      ('${ID(4)}', '${ORG_A}', '350000000000004'), ('${ID(5)}', '${ORG_B}', '350000000000005');
    INSERT INTO vehicles (id, org_id, name, plate, fleet_group, device_id) VALUES
      ('${ID(11)}', '${ORG_A}', 'Furgone 1', 'GA123BC', 'DHL', '${ID(1)}'),
      ('${ID(12)}', '${ORG_A}', 'Furgone 2', 'GB456DE', 'UNIVEX', '${ID(2)}'),
      ('${ID(13)}', '${ORG_A}', 'Sin placa', NULL, NULL, '${ID(3)}'),
      ('${ID(14)}', '${ORG_A}', 'Sin posición', 'GC789FG', NULL, '${ID(4)}'),
      ('${ID(15)}', '${ORG_B}', 'De la otra empresa', 'ZZ999ZZ', NULL, '${ID(5)}');
    INSERT INTO positions (device_id, ts, lat, lng, angle, speed, io_data) VALUES
      ('${ID(1)}', '2026-11-14T10:00:00Z', 45.4642, 9.19, 80, 52, '{"239":1}'),
      ('${ID(2)}', '2026-11-14T09:00:00Z', 45.5, 9.2, 359, 0, '{"239":0}'),
      ('${ID(3)}', '2026-11-14T09:30:00Z', 45.6, 9.3, 10, 10, '{}'),
      ('${ID(5)}', '2026-11-14T10:00:00Z', 41.9, 12.5, 90, 40, '{"239":1}');
  `);

  secret = (await oauth.createOauthClient({ clientId: "app-piazza", name: "App Piazza", redirectUris: [REDIRECT, REDIRECT_DEV] })).clientSecret;
  otherSecret = (await oauth.createOauthClient({ clientId: "otra-app", name: "Otra app", redirectUris: ["https://otra.example/cb"] })).clientSecret;
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("PKCE", () => {
  it("matches the vector of RFC 7636, appendix B", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(oauth.pkceChallengeFor(verifier)).toBe(challenge);
    expect(oauth.verifyPkce(verifier, challenge)).toBe(true);
    expect(oauth.verifyPkce(verifier + "x", challenge)).toBe(false);
    expect(oauth.verifyPkce("corto", challenge)).toBe(false);
  });
});

describe("the authorization request", () => {
  const validate = (query: Record<string, string>) => app.inject({ method: "GET", url: `/oauth/authorize/validate?${form(query)}` });

  it("accepts a valid one and names the app", async () => {
    const res = await validate(authorizeQuery(pkcePair()));
    expect(res.json()).toEqual({ valid: true, clientName: "App Piazza", scope: "vehicles:read" });
  });

  it("refuses a redirect address that is not exactly a registered one, without ever redirecting", async () => {
    for (const redirect_uri of [`${REDIRECT}/`, `${REDIRECT}?x=1`, "https://APP-PIAZZA.vercel.app/mapa/onetrack/oauth", "https://app-piazza.vercel.app/mapa", "https://app-piazza.vercel.app.evil.example/mapa/onetrack/oauth", "https://evil.example/cb"]) {
      const body = (await validate(authorizeQuery(pkcePair(), { redirect_uri }))).json();
      expect(body.valid, redirect_uri).toBe(false);
      expect(body.redirectTo, redirect_uri).toBeUndefined();
    }
    const unknown = (await validate(authorizeQuery(pkcePair(), { client_id: "nadie" }))).json();
    expect(unknown).toMatchObject({ valid: false });
    expect(unknown.redirectTo).toBeUndefined();
  });

  it("requires PKCE with S256: plain and a missing challenge are refused (and the error goes back to the app with its state)", async () => {
    const variants: Array<Record<string, string>> = [{ code_challenge_method: "plain" }, { code_challenge_method: "" }, { code_challenge: "" }, { code_challenge: "corto" }];
    for (const extra of variants) {
      const body = (await validate(authorizeQuery(pkcePair(), extra))).json();
      expect(body.valid, JSON.stringify(extra)).toBe(false);
      const back = new URL(body.redirectTo);
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("state")).toBe("st-123 &=?");
    }
  });

  it("refuses a scope that is not allowed and a response_type other than code", async () => {
    expect((await validate(authorizeQuery(pkcePair(), { scope: "vehicles:write" }))).json()).toMatchObject({ valid: false, error: "invalid_scope" });
    expect((await validate(authorizeQuery(pkcePair(), { response_type: "token" }))).json()).toMatchObject({ valid: false, error: "unsupported_response_type" });
  });
});

describe("the person's decision", () => {
  it("needs a signed-in person, and never one that is only looking at or managing a client's account", async () => {
    const payload = { ...authorizeQuery(pkcePair()), decision: "approve" };
    expect((await app.inject({ method: "POST", url: "/oauth/authorize/decision", payload })).statusCode).toBe(401);
    for (const extra of [{ viewAs: true }, { actingAs: true }]) {
      const headers = { authorization: `Bearer ${app.jwt.sign({ userId: USER_A, orgId: ORG_A, role: "admin", allowedArea: null, ...extra } as never)}` };
      expect((await app.inject({ method: "POST", url: "/oauth/authorize/decision", headers, payload })).statusCode).toBe(403);
    }
  });

  it("goes back to the app with the code and the same state, or with access_denied and the same state", async () => {
    const approved = await authorizeAs(bearer(USER_A, ORG_A));
    expect(approved.url.origin + approved.url.pathname).toBe(REDIRECT);
    expect(approved.url.searchParams.get("state")).toBe("st-123 &=?");
    expect(approved.code).toMatch(/^otc_/);

    const denied = await app.inject({ method: "POST", url: "/oauth/authorize/decision", headers: bearer(USER_A, ORG_A), payload: { ...authorizeQuery(pkcePair()), decision: "deny" } });
    const back = new URL(denied.json().redirectTo);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-123 &=?");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("does not issue a code for an invalid request", async () => {
    const res = await app.inject({ method: "POST", url: "/oauth/authorize/decision", headers: bearer(USER_A, ORG_A), payload: { ...authorizeQuery(pkcePair(), { redirect_uri: "https://evil.example/cb" }), decision: "approve" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).not.toContain("code=");
  });
});

describe("the token endpoint", () => {
  it("exchanges the code (with the verifier) for tokens, including a refresh token and the account name", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const res = await exchange(code, pair);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ expires_in: 3600, token_type: "Bearer", scope: "vehicles:read", account_name: "Gamonal Trasporti" });
    expect(body.access_token).toMatch(/^ota_/);
    expect(body.refresh_token).toMatch(/^otr_/);
  });

  it("stores no secret in clear: only hashes (codes, tokens and the client secret)", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const body = (await exchange(code, pair)).json();
    const dump = JSON.stringify([
      (await pg.query("select * from oauth_clients")).rows,
      (await pg.query("select * from oauth_codes")).rows,
      (await pg.query("select * from oauth_tokens")).rows,
      (await pg.query("select * from oauth_audit_log")).rows,
    ]);
    for (const plain of [secret, otherSecret, code, body.access_token, body.refresh_token]) expect(dump).not.toContain(plain);
  });

  it("refuses a wrong secret, a different redirect address, a wrong verifier, and an unknown grant type", async () => {
    const a = await authorizeAs(bearer(USER_A, ORG_A));
    const badSecret = await exchange(a.code, a.pair).then(async () => tokenRequest({ grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, code_verifier: a.pair.verifier }, "mal-secreto"));
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.json().error).toBe("invalid_client");

    const b = await authorizeAs(bearer(USER_A, ORG_A));
    const otherRedirect = await exchange(b.code, b.pair, { redirect_uri: REDIRECT_DEV });
    expect(otherRedirect.statusCode).toBe(400);
    expect(otherRedirect.json().error).toBe("invalid_grant");

    const c = await authorizeAs(bearer(USER_A, ORG_A));
    const badVerifier = await exchange(c.code, { verifier: pkcePair().verifier });
    expect(badVerifier.json().error).toBe("invalid_grant");

    const grant = await tokenRequest({ grant_type: "password" });
    expect(grant.statusCode).toBe(400);
    expect(grant.json().error).toBe("unsupported_grant_type");
    expect((await tokenRequest({ grant_type: "authorization_code" })).json().error).toBe("invalid_request");
  });

  it("takes a code from another app for invalid", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const res = await app.inject({ method: "POST", url: "/oauth/token", headers: FORM, payload: form({ client_id: "otra-app", client_secret: otherSecret, grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pair.verifier }) });
    expect(res.json().error).toBe("invalid_grant");
  });

  it("lets a code be used once; presenting it again revokes what it produced", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const first = (await exchange(code, pair)).json();
    expect((await positions(first.access_token)).statusCode).toBe(200);

    const again = await exchange(code, pair);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_grant");
    expect((await positions(first.access_token)).statusCode).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token })).json().error).toBe("invalid_grant");
  });

  it("refuses an expired code", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const client = await oauth.authenticateClient("app-piazza", secret);
    await expect(oauth.exchangeAuthorizationCode(client, { code, redirect_uri: REDIRECT, code_verifier: pair.verifier }, new Date(Date.now() + 11 * 60_000))).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rotates the refresh token on every use; presenting an old one revokes the whole chain", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const first = (await exchange(code, pair)).json();

    const second = (await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token })).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.account_name).toBe("Gamonal Trasporti");
    expect((await positions(second.access_token)).statusCode).toBe(200);

    const stolen = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe("invalid_grant");
    expect((await positions(second.access_token)).statusCode).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: second.refresh_token })).json().error).toBe("invalid_grant");
  });
});

describe("revocation", () => {
  const revoke = (data: Record<string, string>, clientId = "app-piazza", clientSecret = secret) =>
    app.inject({ method: "POST", url: "/oauth/revoke", headers: FORM, payload: form({ client_id: clientId, client_secret: clientSecret, ...data }) });

  it("revokes the refresh token and its access tokens, and answers 200 even when the token does not exist", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const tokens = (await exchange(code, pair)).json();
    expect((await revoke({ token: tokens.refresh_token, token_type_hint: "refresh_token" })).statusCode).toBe(200);
    expect((await positions(tokens.access_token)).statusCode).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json().error).toBe("invalid_grant");
    expect((await revoke({ token: "otr_no-existe" })).statusCode).toBe(200);
    expect((await revoke({ token: tokens.refresh_token }, "app-piazza", "mal")).statusCode).toBe(401);
  });

  it("does nothing to a token of another app", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const tokens = (await exchange(code, pair)).json();
    expect((await revoke({ token: tokens.access_token }, "otra-app", otherSecret)).statusCode).toBe(200);
    expect((await positions(tokens.access_token)).statusCode).toBe(200);
  });

  it("lets the person see their connected apps and disconnect one, and only their own", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_B, ORG_B));
    const tokens = (await exchange(code, pair)).json();
    const list = await app.inject({ method: "GET", url: "/oauth/connections", headers: bearer(USER_B, ORG_B) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ clientName: "App Piazza", scope: "vehicles:read" });
    const id = list.json()[0].id as string;

    expect((await app.inject({ method: "DELETE", url: `/oauth/connections/${id}`, headers: bearer(USER_A, ORG_A) })).statusCode).toBe(404);
    expect((await positions(tokens.access_token)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/oauth/connections/${id}`, headers: bearer(USER_B, ORG_B) })).statusCode).toBe(204);
    expect((await positions(tokens.access_token)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/oauth/connections", headers: bearer(USER_B, ORG_B) })).json()).toEqual([]);
  });
});

describe("the positions of the fleet", () => {
  it("answers 401 without a token, with a wrong one and with a login token (which is not an access token)", async () => {
    expect((await app.inject({ method: "GET", url: "/oauth/fleet/live-positions" })).statusCode).toBe(401);
    expect((await positions("ota_inventado")).statusCode).toBe(401);
    expect((await positions(app.jwt.sign({ userId: USER_A, orgId: ORG_A, role: "owner", allowedArea: null } as never))).statusCode).toBe(401);
  });

  it("gives, in one answer, the last position of the vehicles of THIS person's account, in the agreed format", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const token = (await exchange(code, pair)).json().access_token as string;
    const res = await positions(token);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.plate).sort()).toEqual(["GA123BC", "GB456DE"]); // not the plateless one, not the one with no position, never ZZ999ZZ of the other company
    const moving = rows.find((r) => r.plate === "GA123BC")!;
    expect(moving).toEqual({ plate: "GA123BC", lat: 45.4642, lng: 9.19, speed: 52, ignition: true, heading: 80, ts: "2026-11-14T10:00:00.000Z" });
    const parked = rows.find((r) => r.plate === "GB456DE")!;
    expect(parked).toMatchObject({ speed: 0, ignition: false, heading: 359, ts: "2026-11-14T09:00:00.000Z" }); // its real, older time
  });

  it("never shows one person the vehicles of another company", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_B, ORG_B));
    const rows = (await positions((await exchange(code, pair)).json().access_token)).json() as Array<{ plate: string }>;
    expect(rows.map((r) => r.plate)).toEqual(["ZZ999ZZ"]);
  });

  it("gives OneSystec's own people the vehicles of every client (the platform owns the hardware)", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_PLATFORM, ORG_B));
    const rows = (await positions((await exchange(code, pair)).json().access_token)).json() as Array<{ plate: string }>;
    expect(rows.map((r) => r.plate).sort()).toEqual(["GA123BC", "GB456DE", "ZZ999ZZ"]);
  });

  it("respects the fleet of the person (a client limited to DHL sees only DHL)", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_AREA, ORG_A, "viewer", "DHL"));
    const rows = (await positions((await exchange(code, pair)).json().access_token)).json() as Array<{ plate: string }>;
    expect(rows.map((r) => r.plate)).toEqual(["GA123BC"]);
  });

  it("answers 403 to a person whose account has no map", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_NOMAP, ORG_A, "viewer"));
    const res = await positions((await exchange(code, pair)).json().access_token);
    expect(res.statusCode).toBe(403);
  });

  it("answers 403 to a connection without the vehicles:read scope", async () => {
    const clientRow = (await pg.query<{ id: string }>("select id from oauth_clients where client_id = 'app-piazza'")).rows[0]!.id;
    const grantId = (await pg.query<{ id: string }>("insert into oauth_grants (user_id, client_id, scope) values ($1, $2, 'otro') returning id", [USER_A, clientRow])).rows[0]!.id;
    const token = "ota_" + randomBytes(24).toString("base64url");
    await pg.query("insert into oauth_tokens (grant_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at) values ($1, $2, $3, now() + interval '1 hour', now() + interval '1 day')", [
      grantId,
      createHash("sha256").update(token).digest("hex"),
      createHash("sha256").update("otr_x").digest("hex"),
    ]);
    const res = await positions(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
  });

  it("stops an access token once it has expired", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const token = (await exchange(code, pair)).json().access_token as string;
    expect(await oauth.authenticateAccessToken(token)).not.toBeNull();
    expect(await oauth.authenticateAccessToken(token, new Date(Date.now() + 61 * 60_000))).toBeNull();
  });
});

describe("choosing which vehicles an app sees", () => {
  const connect = async (headers: Record<string, string>) => {
    const { pair, code } = await authorizeAs(headers);
    const token = (await exchange(code, pair)).json().access_token as string;
    const list = await app.inject({ method: "GET", url: "/oauth/connections", headers });
    const id = (list.json() as Array<{ id: string }>)[0]!.id;
    return { token, id };
  };
  const plates = async (token: string) => ((await positions(token)).json() as Array<{ plate: string }>).map((r) => r.plate).sort();
  const put = (id: string, headers: Record<string, string>, vehicleIds: string[] | null) =>
    app.inject({ method: "PUT", url: `/oauth/connections/${id}/vehicles`, headers, payload: { vehicleIds } });

  it("shares everything by default and lists what the person can offer, each one marked", async () => {
    const headers = bearer(USER_PLATFORM, ORG_B);
    const { id } = await connect(headers);
    const res = await app.inject({ method: "GET", url: `/oauth/connections/${id}/vehicles`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { all: boolean; vehicles: Array<{ plate: string; shared: boolean; organization: string }> };
    expect(body.all).toBe(true);
    expect(body.vehicles.map((v) => v.plate)).toEqual(["GA123BC", "GB456DE", "GC789FG", "ZZ999ZZ"]);
    expect(body.vehicles.every((v) => v.shared)).toBe(true);
    expect(body.vehicles.find((v) => v.plate === "ZZ999ZZ")!.organization).toBe("Altra Azienda");
  });

  it("makes the app see only the vehicles the person picked, and goes back to all with null", async () => {
    const headers = bearer(USER_PLATFORM, ORG_B);
    const { token, id } = await connect(headers);
    expect((await put(id, headers, [ID(11), ID(15)])).statusCode).toBe(204);
    expect(await plates(token)).toEqual(["GA123BC", "ZZ999ZZ"]);

    const list = (await app.inject({ method: "GET", url: `/oauth/connections/${id}/vehicles`, headers })).json() as { all: boolean; vehicles: Array<{ plate: string; shared: boolean }> };
    expect(list.all).toBe(false);
    expect(list.vehicles.filter((v) => v.shared).map((v) => v.plate)).toEqual(["GA123BC", "ZZ999ZZ"]);
    const connections = (await app.inject({ method: "GET", url: "/oauth/connections", headers })).json() as Array<{ sharedVehicles: number | null }>;
    expect(connections[0]!.sharedVehicles).toBe(2);

    expect((await put(id, headers, null)).statusCode).toBe(204);
    expect(await plates(token)).toEqual(["GA123BC", "GB456DE", "ZZ999ZZ"]);
  });

  it("can share none at all", async () => {
    const headers = bearer(USER_PLATFORM, ORG_B);
    const { token, id } = await connect(headers);
    expect((await put(id, headers, [])).statusCode).toBe(204);
    expect(await plates(token)).toEqual([]);
  });

  it("refuses to share a vehicle the person does not see, or a connection that is not theirs", async () => {
    const headers = bearer(USER_A, ORG_A);
    const { token, id } = await connect(headers);
    expect((await put(id, headers, [ID(15)])).statusCode).toBe(400); // ZZ999ZZ belongs to another company
    expect((await put(id, headers, ["not-an-id"])).statusCode).toBe(400);
    expect(await plates(token)).toEqual(["GA123BC", "GB456DE"]); // nothing changed
    expect((await put(id, bearer(USER_B, ORG_B), [ID(15)])).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/oauth/connections/${id}/vehicles`, headers: bearer(USER_B, ORG_B) })).statusCode).toBe(404);
  });

  it("is only for the person themselves: not an API key, not someone looking at a client's account", async () => {
    const { id } = await connect(bearer(USER_A, ORG_A));
    const viewing = { authorization: `Bearer ${app.jwt.sign({ userId: USER_A, orgId: ORG_A, role: "owner", allowedArea: null, viewAs: { orgId: ORG_B } } as never)}` };
    expect((await put(id, viewing, [ID(11)])).statusCode).toBe(403);
    expect((await put(id, {}, [ID(11)])).statusCode).toBe(401);
  });
});

describe("read-only by construction", () => {
  it("is refused by every other route of the API: an access token is not a login token", async () => {
    const { pair, code } = await authorizeAs(bearer(USER_A, ORG_A));
    const token = (await exchange(code, pair)).json().access_token as string;
    const headers = { authorization: `Bearer ${token}` };
    for (const [method, url] of [["GET", "/vehicles"], ["GET", "/positions/latest"], ["GET", "/me"], ["POST", "/vehicles"], ["PATCH", `/vehicles/${ID(11)}`], ["DELETE", `/vehicles/${ID(11)}`], ["GET", "/oauth/connections"]] as const) {
      const res = await app.inject({ method, url, headers, payload: method === "GET" || method === "DELETE" ? undefined : ({ name: "x" } as never) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("the audit trail", () => {
  it("records authorizing, renewing, revoking and denying, with the person and the app but no secret", async () => {
    const events = (await pg.query<{ event: string }>("select distinct event from oauth_audit_log")).rows.map((r) => r.event);
    for (const event of ["authorize", "deny", "token_issued", "refresh", "revoke", "reuse_detected"]) expect(events, event).toContain(event);
  });
});

describe("the brakes", () => {
  it("answers 429 to too many attempts at the token endpoint from one address", async () => {
    let last = 0;
    for (let i = 0; i < 80 && last !== 429; i++) {
      last = (await app.inject({ method: "POST", url: "/oauth/token", headers: FORM, payload: form({ client_id: "app-piazza", client_secret: "mal", grant_type: "refresh_token", refresh_token: "otr_x" }) })).statusCode;
    }
    expect(last).toBe(429);
  });
});
