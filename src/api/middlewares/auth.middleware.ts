import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticateApiKey, looksLikeApiKey } from "../../services/apiKey.service.js";

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
    const result = await authenticateApiKey(bearerToken);
    if (!result) {
      await reply.code(401).send({ error: "Invalid or revoked API key" });
      return;
    }
    request.user = { userId: "api-key", orgId: result.orgId, role: "owner" };
    return;
  }

  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

export function requireRole(...roles: Array<"owner" | "admin" | "viewer">) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!roles.includes(request.user.role)) {
      await reply.code(403).send({ error: "Forbidden" });
    }
  };
}
