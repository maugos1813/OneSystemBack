import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  oauthAuditLog,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  organizations,
  users,
  type OauthClient,
} from "../db/schema/index.js";

/**
 * OAuth 2.0 authorization code + PKCE (S256), for apps of the owner that read a person's vehicles with that person's consent ("Sign in with
 * OneTrack"). Opaque random tokens, kept only as SHA-256 hashes. Everything here takes `now` so a test can move the clock.
 */

export const SCOPE_VEHICLES_READ = "vehicles:read";
export const SUPPORTED_SCOPES = [SCOPE_VEHICLES_READ] as const;
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_MS = 180 * 86_400_000;

const ACCESS_PREFIX = "ota_";
const REFRESH_PREFIX = "otr_";
const CODE_PREFIX = "otc_";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (prefix: string): string => prefix + randomBytes(32).toString("base64url");

/** Constant-time comparison of two secrets (their hashes, so the lengths always match). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
}

/** RFC 7636: the challenge is the unpadded base64url of the SHA-256 of the verifier. */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const VERIFIER_FORMAT = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_FORMAT = /^[A-Za-z0-9\-_]{43}$/;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER_FORMAT.test(verifier)) return false;
  return sameSecret(pkceChallengeFor(verifier), challenge);
}

/** A failure the endpoints turn into the standard OAuth error answers. */
export class OAuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "unsupported_response_type" | "invalid_scope" | "access_denied",
    readonly description: string,
    readonly status: 400 | 401 = 400,
  ) {
    super(description);
  }
}

async function audit(event: string, userId: string | null, clientId: string | null, detail?: string): Promise<void> {
  try {
    await db.insert(oauthAuditLog).values({ event, userId, clientId, detail: detail?.slice(0, 200) ?? null });
  } catch {
    // The audit trail never blocks the sign-in it records.
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Clients

export interface CreatedClient {
  clientId: string;
  /** The plaintext secret: only ever available here, right after creating the client. */
  clientSecret: string;
}

export async function createOauthClient(input: { clientId: string; name: string; redirectUris: string[]; scopes?: string[] }): Promise<CreatedClient> {
  const clientSecret = randomToken("ocs_");
  await db.insert(oauthClients).values({
    clientId: input.clientId,
    secretHash: sha256(clientSecret),
    name: input.name,
    redirectUris: input.redirectUris,
    scopes: input.scopes ?? [SCOPE_VEHICLES_READ],
  });
  return { clientId: input.clientId, clientSecret };
}

async function findClient(clientId: string): Promise<OauthClient | undefined> {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return client && client.active ? client : undefined;
}

/** The app that sends its id and secret (token and revoke endpoints). */
export async function authenticateClient(clientId: unknown, clientSecret: unknown): Promise<OauthClient> {
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret) {
    throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
  const client = await findClient(clientId);
  // Always compare, even for an unknown client, so the time does not say whether the id exists.
  const stored = client?.secretHash ?? sha256("no-such-client");
  const matches = timingSafeEqual(Buffer.from(sha256(clientSecret), "hex"), Buffer.from(stored, "hex"));
  if (!client || !matches) throw new OAuthError("invalid_client", "Client authentication failed", 401);
  return client;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Authorization (what the consent page asks)

export interface AuthorizeParams {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  scope?: unknown;
  state?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
}

export type AuthorizeCheck =
  | { ok: true; client: OauthClient; redirectUri: string; scope: string; state: string | null; codeChallenge: string }
  /** `redirectable`: the app and the address are known, so the error may go back to the app; otherwise only a page shows it. */
  | { ok: false; error: OAuthError["code"]; description: string; redirectable: false }
  | { ok: false; error: OAuthError["code"]; description: string; redirectable: true; redirectUri: string; state: string | null };

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export async function checkAuthorizeRequest(params: AuthorizeParams): Promise<AuthorizeCheck> {
  const clientId = str(params.client_id);
  const redirectUri = str(params.redirect_uri);
  if (!clientId || !redirectUri) return { ok: false, error: "invalid_request", description: "client_id and redirect_uri are required", redirectable: false };
  const client = await findClient(clientId);
  if (!client) return { ok: false, error: "invalid_request", description: "Unknown application", redirectable: false };
  // Exactly one of the registered addresses, character for character: no wildcards, no prefixes, no normalization.
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: "invalid_request", description: "The redirect address is not registered for this application", redirectable: false };
  }
  const state = str(params.state);
  const fail = (error: OAuthError["code"], description: string): AuthorizeCheck => ({ ok: false, error, description, redirectable: true, redirectUri, state });

  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const scope = str(params.scope) ?? SCOPE_VEHICLES_READ;
  const asked = scope.split(" ").filter(Boolean);
  if (asked.length === 0 || asked.some((s) => !client.scopes.includes(s) || !(SUPPORTED_SCOPES as readonly string[]).includes(s))) {
    return fail("invalid_scope", "The requested scope is not allowed for this application");
  }
  const challenge = str(params.code_challenge);
  if (params.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (!challenge || !CHALLENGE_FORMAT.test(challenge)) return fail("invalid_request", "A valid code_challenge is required");
  return { ok: true, client, redirectUri, scope: asked.join(" "), state, codeChallenge: challenge };
}

/** The person approved: the one-use code that goes back to the app. */
export async function issueAuthorizationCode(userId: string, check: Extract<AuthorizeCheck, { ok: true }>, now: Date = new Date()): Promise<string> {
  const code = randomToken(CODE_PREFIX);
  await db.insert(oauthCodes).values({
    codeHash: sha256(code),
    userId,
    clientId: check.client.id,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    scope: check.scope,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });
  await audit("authorize", userId, check.client.clientId);
  return code;
}

export async function recordDenied(userId: string, clientId: string): Promise<void> {
  await audit("deny", userId, clientId);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Token endpoint

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
  account_name: string;
}

async function accountNameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row?.name ?? "";
}

async function issueTokens(grantId: string, userId: string, scope: string, now: Date): Promise<TokenResponse> {
  const access = randomToken(ACCESS_PREFIX);
  const refresh = randomToken(REFRESH_PREFIX);
  await db.insert(oauthTokens).values({
    grantId,
    accessHash: sha256(access),
    refreshHash: sha256(refresh),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
  });
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_SECONDS, token_type: "Bearer", scope, account_name: await accountNameOf(userId) };
}

/** Ends a connection: the connection itself and every token of its chain. */
async function revokeGrant(grantId: string, now: Date): Promise<void> {
  await db.update(oauthGrants).set({ revokedAt: now }).where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
  await db.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
}

export async function exchangeAuthorizationCode(
  client: OauthClient,
  input: { code?: unknown; redirect_uri?: unknown; code_verifier?: unknown },
  now: Date = new Date(),
): Promise<TokenResponse> {
  const code = str(input.code);
  const redirectUri = str(input.redirect_uri);
  const verifier = str(input.code_verifier);
  if (!code || !redirectUri || !verifier) throw new OAuthError("invalid_request", "code, redirect_uri and code_verifier are required");

  const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, sha256(code))).limit(1);
  if (!row || row.clientId !== client.id) throw new OAuthError("invalid_grant", "The code is not valid");

  // A code that was already used is a code that was copied: what it produced is revoked.
  if (row.usedAt) {
    if (row.grantId) await revokeGrant(row.grantId, now);
    await audit("reuse_detected", row.userId, client.clientId, "authorization code presented twice");
    throw new OAuthError("invalid_grant", "The code was already used");
  }
  if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "The code has expired");
  if (row.redirectUri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the one of the authorization");
  if (!verifyPkce(verifier, row.codeChallenge)) throw new OAuthError("invalid_grant", "The PKCE code_verifier does not match");

  // Consumed once, atomically: two simultaneous exchanges cannot both win.
  const [claimed] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
    .returning({ id: oauthCodes.id });
  if (!claimed) throw new OAuthError("invalid_grant", "The code was already used");

  // One live connection per person and app: authorizing again replaces the previous one.
  const previous = await db
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.userId, row.userId), eq(oauthGrants.clientId, client.id), isNull(oauthGrants.revokedAt)));
  for (const old of previous) await revokeGrant(old.id, now);

  const [grant] = await db.insert(oauthGrants).values({ userId: row.userId, clientId: client.id, scope: row.scope }).returning();
  await db.update(oauthCodes).set({ grantId: grant!.id }).where(eq(oauthCodes.id, row.id));
  const tokens = await issueTokens(grant!.id, row.userId, row.scope, now);
  await audit("token_issued", row.userId, client.clientId);
  return tokens;
}

export async function refreshAccessToken(client: OauthClient, input: { refresh_token?: unknown }, now: Date = new Date()): Promise<TokenResponse> {
  const refresh = str(input.refresh_token);
  if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required");

  const [row] = await db
    .select({ token: oauthTokens, grant: oauthGrants })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .where(eq(oauthTokens.refreshHash, sha256(refresh)))
    .limit(1);
  if (!row || row.grant.clientId !== client.id) throw new OAuthError("invalid_grant", "The refresh token is not valid");
  if (row.grant.revokedAt || row.token.revokedAt) throw new OAuthError("invalid_grant", "The refresh token was revoked");

  // Already exchanged for the next pair: someone is using a copy. The whole chain stops working.
  if (row.token.usedAt) {
    await revokeGrant(row.grant.id, now);
    await audit("reuse_detected", row.grant.userId, client.clientId, "refresh token presented twice");
    throw new OAuthError("invalid_grant", "The refresh token was already used");
  }
  if (row.token.refreshExpiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "The refresh token has expired");

  const [claimed] = await db
    .update(oauthTokens)
    .set({ usedAt: now })
    .where(and(eq(oauthTokens.id, row.token.id), isNull(oauthTokens.usedAt)))
    .returning({ id: oauthTokens.id });
  if (!claimed) {
    await revokeGrant(row.grant.id, now);
    await audit("reuse_detected", row.grant.userId, client.clientId, "refresh token raced");
    throw new OAuthError("invalid_grant", "The refresh token was already used");
  }
  const tokens = await issueTokens(row.grant.id, row.grant.userId, row.grant.scope, now);
  await audit("refresh", row.grant.userId, client.clientId);
  return tokens;
}

/** RFC 7009: ends the connection of that token. Never says whether the token existed. */
export async function revokeToken(client: OauthClient, token: unknown, now: Date = new Date()): Promise<void> {
  const value = str(token);
  if (!value) return;
  const hash = sha256(value);
  const [byRefresh] = await db.select({ grantId: oauthTokens.grantId }).from(oauthTokens).where(eq(oauthTokens.refreshHash, hash)).limit(1);
  const found = byRefresh ?? (await db.select({ grantId: oauthTokens.grantId }).from(oauthTokens).where(eq(oauthTokens.accessHash, hash)).limit(1))[0];
  if (!found) return;
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, found.grantId)).limit(1);
  if (!grant || grant.clientId !== client.id) return; // not this app's token: nothing happens, and nothing is said
  await revokeGrant(grant.id, now);
  await audit("revoke", grant.userId, client.clientId, "revoked by the app");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Using an access token

export interface AccessGrant {
  userId: string;
  grantId: string;
  scope: string;
  clientId: string;
}

/** The connection behind an access token, or null when it is unknown, expired or revoked. */
export async function authenticateAccessToken(token: string, now: Date = new Date()): Promise<AccessGrant | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const [row] = await db
    .select({ token: oauthTokens, grant: oauthGrants, clientActive: oauthClients.active, clientId: oauthClients.clientId })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(eq(oauthTokens.accessHash, sha256(token)))
    .limit(1);
  if (!row || row.token.revokedAt || row.grant.revokedAt || !row.clientActive) return null;
  if (row.token.accessExpiresAt.getTime() <= now.getTime()) return null;
  return { userId: row.grant.userId, grantId: row.grant.id, scope: row.grant.scope, clientId: row.clientId };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// "Connected applications" of a person

export interface Connection {
  id: string;
  clientName: string;
  scope: string;
  connectedAt: Date;
}

export async function listConnections(userId: string): Promise<Connection[]> {
  return db
    .select({ id: oauthGrants.id, clientName: oauthClients.name, scope: oauthGrants.scope, connectedAt: oauthGrants.createdAt })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    .orderBy(desc(oauthGrants.createdAt));
}

/** The person disconnects an app. False when it is not theirs (or already gone). */
export async function revokeConnection(userId: string, grantId: string, now: Date = new Date()): Promise<boolean> {
  const [grant] = await db
    .select({ id: oauthGrants.id, clientId: oauthClients.clientId })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    .limit(1);
  if (!grant) return false;
  await revokeGrant(grant.id, now);
  await audit("revoke", userId, grant.clientId, "revoked by the user");
  return true;
}
