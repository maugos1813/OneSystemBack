import type { FastifyReply, FastifyRequest } from "fastify";

/** Verifies the JWT and populates request.user; fails the request with 401 otherwise. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
