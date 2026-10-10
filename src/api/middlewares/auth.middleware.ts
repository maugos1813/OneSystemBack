import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticateApiKey, looksLikeApiKey } from "../../services/apiKey.service.js";

// Vehicle-data reads that existing integrations already call with an API key before /v1
// existed. Read-only and deprecated: new integrations should use /v1, and this list should
// shrink to nothing once they have moved.
const LEGACY_API_KEY_READS = /^\/vehicles(\/[0-9a-fA-F-]{36}(\/positions(\/latest)?|\/events)?)?$/;

/**
 * An API key is a read-only credential for third-party apps: it may only GET/HEAD, and
 * only the public /v1 API (plus the legacy vehicle reads above). Everything else — every
 * write, and every settings/team/geofence/device/toll endpoint — is for logged-in users.
 */
export function isApiKeyRequestAllowed(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const path = url.split("?")[0]!;
  return path.startsWith("/v1/") || LEGACY_API_KEY_READS.test(path);
}

/**
 * Accepts either a user JWT (issued on login, for the frontend) or an org API key
 * (issued from the API Keys page, for third-party integrations) in the same
 * `Authorization: Bearer <token>` header, and populates request.user either way so
 * every route downstream only ever deals with { userId, orgId, role }.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (bearerToken && looksLikeApiKey(bearerToken)) {
    if (!isApiKeyRequestAllowed(request.method, request.url)) {
      await reply.code(403).send({ error: "API keys are read-only and can only be used on the /v1 API" });
      return;
    }
    const result = await authenticateApiKey(bearerToken);
    if (!result) {
      await reply.code(401).send({ error: "Invalid or revoked API key" });
      return;
    }
    // "viewer", not "owner": even if a write route were ever exposed by mistake, the
    // role checks on mutations would still refuse an API key.
    request.user = { userId: "api-key", orgId: result.orgId, role: "viewer" };
    request.apiKeyId = result.keyId;
    return;
  }

  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

/** For the public /v1 API: only API keys, never a login JWT. */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (!request.apiKeyId) {
    await reply.code(401).send({ error: "The /v1 API requires an API key (Authorization: Bearer osk_live_...)" });
  }
}

export function requireRole(...roles: Array<"owner" | "admin" | "manager" | "viewer">) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!roles.includes(request.user.role)) {
      await reply.code(403).send({ error: "Forbidden" });
      return;
    }
  };
}
