import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getCurrentUser } from "../../services/auth.service.js";
import {
  authenticateAccessToken,
  authenticateClient,
  checkAuthorizeRequest,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  listConnections,
  OAuthError,
  recordDenied,
  refreshAccessToken,
  revokeConnection,
  revokeToken,
  SCOPE_VEHICLES_READ,
  type AuthorizeCheck,
} from "../../services/oauth.service.js";
import { getLatestPositionsForDevices } from "../../services/position.service.js";
import { listVehiclesForOrg } from "../../services/vehicle.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { clientAddress } from "../middlewares/loginRateLimit.js";
import { FixedWindowLimiter } from "../middlewares/rateLimit.js";

/**
 * "Sign in with OneTrack" (OAuth 2.0 authorization code + PKCE). The page the person sees (login and consent) is in the website, which asks
 * these routes to check the request and to record the decision; the app that is being connected only talks to /oauth/token, /oauth/revoke
 * and the positions route. Access tokens are opaque and are NOT login tokens: the rest of the API does not accept them, so a connected app can
 * never write anything, only read what this file lets it read.
 */

const MAX_VEHICLES = 500;
const IGNITION_ID = "239";

const limits = {
  validateByAddress: new FixedWindowLimiter(60, 60_000),
  decisionByUser: new FixedWindowLimiter(30, 60_000),
  tokenByAddress: new FixedWindowLimiter(60, 60_000),
  tokenByClient: new FixedWindowLimiter(300, 60_000),
  positionsByGrant: new FixedWindowLimiter(120, 60_000),
};

async function tooMany(reply: FastifyReply, retryAfterSec: number): Promise<FastifyReply> {
  void reply.header("Retry-After", retryAfterSec);
  return reply.code(429).send({ error: "too_many_requests", error_description: "Too many requests. Try again later." });
}

/** The error answer of the token and revoke endpoints (RFC 6749 §5.2). Never cached. */
function oauthError(reply: FastifyReply, err: OAuthError): FastifyReply {
  void reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
  return reply.code(err.status).send({ error: err.code, error_description: err.description });
}

/** Where the answer goes back to the app: its own registered address, with `state` returned as received. */
function backToApp(redirectUri: string, state: string | null, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

const bodyOf = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {});

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // The token and revoke endpoints receive application/x-www-form-urlencoded (RFC 6749): parsed here, for this plugin only.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // --- The consent page asks: is this request valid, and which app is it? (No login needed to look; nothing private is answered.)
  app.get("/oauth/authorize/validate", { schema: { tags: ["OAuth"], summary: "Comprueba una petición de autorización y dice qué aplicación es" } }, async (request, reply) => {
    const gate = limits.validateByAddress.hit(clientAddress(request));
    if (!gate.allowed) return tooMany(reply, gate.retryAfterSec);
    const check = await checkAuthorizeRequest(request.query as Record<string, unknown>);
    if (check.ok) return { valid: true, clientName: check.client.name, scope: check.scope };
    return check.redirectable
      ? { valid: false, error: check.error, description: check.description, redirectTo: backToApp(check.redirectUri, check.state, { error: check.error, error_description: check.description }) }
      : { valid: false, error: check.error, description: check.description };
  });

  // --- The person decided (they are signed in, with the 2FA of their login): the answer that goes back to the app.
  const decisionBody = z.object({
    decision: z.enum(["approve", "deny"]),
    response_type: z.unknown().optional(),
    client_id: z.unknown().optional(),
    redirect_uri: z.unknown().optional(),
    scope: z.unknown().optional(),
    state: z.unknown().optional(),
    code_challenge: z.unknown().optional(),
    code_challenge_method: z.unknown().optional(),
  });
  app.post(
    "/oauth/authorize/decision",
    { onRequest: requireAuth, schema: { tags: ["OAuth"], summary: "Registra la decisión de la persona y devuelve a dónde volver", security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      // Only a person's own session authorizes: never OneSystec looking at or managing a client's account, never an API key.
      if (request.apiKeyId || request.user.viewAs || request.user.actingAs) return reply.code(403).send({ error: "forbidden" });
      const gate = limits.decisionByUser.hit(request.user.userId);
      if (!gate.allowed) return tooMany(reply, gate.retryAfterSec);
      const body = decisionBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_request" });

      const check: AuthorizeCheck = await checkAuthorizeRequest(body.data as Record<string, unknown>);
      if (!check.ok) {
        if (!check.redirectable) return reply.code(400).send({ error: check.error, description: check.description });
        return { redirectTo: backToApp(check.redirectUri, check.state, { error: check.error, error_description: check.description }) };
      }
      if (body.data.decision === "deny") {
        await recordDenied(request.user.userId, check.client.clientId);
        return { redirectTo: backToApp(check.redirectUri, check.state, { error: "access_denied" }) };
      }
      const code = await issueAuthorizationCode(request.user.userId, check);
      return { redirectTo: backToApp(check.redirectUri, check.state, { code }) };
    },
  );

  // --- The app exchanges its code (or renews its tokens). Server to server.
  app.post("/oauth/token", { schema: { tags: ["OAuth"], summary: "Canjea el código por tokens, o renueva el refresh_token" } }, async (request, reply) => {
    const body = bodyOf(request);
    const byAddress = limits.tokenByAddress.hit(clientAddress(request));
    const byClient = limits.tokenByClient.hit(typeof body.client_id === "string" ? body.client_id : "-");
    if (!byAddress.allowed || !byClient.allowed) return tooMany(reply, Math.max(byAddress.retryAfterSec, byClient.retryAfterSec));
    try {
      const client = await authenticateClient(body.client_id, body.client_secret);
      let tokens;
      if (body.grant_type === "authorization_code") tokens = await exchangeAuthorizationCode(client, body);
      else if (body.grant_type === "refresh_token") tokens = await refreshAccessToken(client, body);
      else throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
      void reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      return tokens;
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, err);
      throw err;
    }
  });

  // --- The app disconnects a person (RFC 7009): 200 whether or not the token existed.
  app.post("/oauth/revoke", { schema: { tags: ["OAuth"], summary: "Revoca un refresh_token (y sus access_token)" } }, async (request, reply) => {
    const body = bodyOf(request);
    const byAddress = limits.tokenByAddress.hit(clientAddress(request));
    const byClient = limits.tokenByClient.hit(typeof body.client_id === "string" ? body.client_id : "-");
    if (!byAddress.allowed || !byClient.allowed) return tooMany(reply, Math.max(byAddress.retryAfterSec, byClient.retryAfterSec));
    try {
      const client = await authenticateClient(body.client_id, body.client_secret);
      await revokeToken(client, body.token);
      return reply.code(200).send({});
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(reply, err);
      throw err;
    }
  });

  // --- What a connected app reads: the last position of every vehicle THIS person sees in their account, in one query.
  app.get("/oauth/fleet/live-positions", { schema: { tags: ["OAuth"], summary: "Última posición de los vehículos que ve la persona que autorizó (scope vehicles:read)" } }, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const grant = token ? await authenticateAccessToken(token) : null;
    if (!grant) {
      void reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return reply.code(401).send({ error: "invalid_token" });
    }
    if (!grant.scope.split(" ").includes(SCOPE_VEHICLES_READ)) {
      void reply.header("WWW-Authenticate", 'Bearer error="insufficient_scope", scope="vehicles:read"');
      return reply.code(403).send({ error: "insufficient_scope" });
    }
    const gate = limits.positionsByGrant.hit(grant.grantId);
    if (!gate.allowed) return tooMany(reply, gate.retryAfterSec);

    // What the person sees in OneTrack, as it is NOW (their permissions can change after they authorized): their company, their fleet if
    // they have one, and only if their account includes the map.
    const user = await getCurrentUser(grant.userId);
    if (!user || !user.modules.includes("mapa")) return reply.code(403).send({ error: "insufficient_permissions" });
    const vehicles = (await listVehiclesForOrg(user.orgId, user.allowedArea)).filter((vehicle) => vehicle.plate && vehicle.deviceId);
    const byDevice = await getLatestPositionsForDevices(vehicles.map((vehicle) => vehicle.deviceId!));

    const out: Array<{ plate: string; lat: number; lng: number; speed: number; ignition: boolean; heading: number; ts: string }> = [];
    for (const vehicle of vehicles) {
      const position = byDevice.get(vehicle.deviceId!);
      if (!position || (position.lat === 0 && position.lng === 0)) continue; // never had a fix
      const ignition = (position.ioData as Record<string, unknown> | null)?.[IGNITION_ID];
      out.push({
        plate: vehicle.plate!,
        lat: position.lat,
        lng: position.lng,
        speed: Math.round(position.speed),
        ignition: ignition === 1 || ignition === "1",
        heading: ((Math.round(position.angle) % 360) + 360) % 360,
        ts: position.ts.toISOString(),
      });
      if (out.length >= MAX_VEHICLES) break;
    }
    void reply.header("Cache-Control", "no-store");
    return out;
  });

  // --- "Connected applications" of the signed-in person.
  app.get(
    "/oauth/connections",
    { onRequest: requireAuth, schema: { tags: ["OAuth"], summary: "Aplicaciones conectadas a tu cuenta", security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      if (request.apiKeyId || request.user.viewAs) return reply.code(403).send({ error: "forbidden" });
      return listConnections(request.user.userId);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/oauth/connections/:id",
    { onRequest: requireAuth, schema: { tags: ["OAuth"], summary: "Desconectar una aplicación de tu cuenta", security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      if (request.apiKeyId || request.user.viewAs) return reply.code(403).send({ error: "forbidden" });
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: "invalid_request" });
      const revoked = await revokeConnection(request.user.userId, id.data);
      return revoked ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
    },
  );
}
