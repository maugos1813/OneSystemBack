export interface JwtPayload {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "manager" | "viewer";
  /** Hard restriction to one área (e.g. "DHL"/"UNIVEX") — null/undefined means unrestricted. */
  allowedArea?: string | null;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** OpenAPI document of the public /v1 API only (a second @fastify/swagger instance). */
    swaggerPublic: () => unknown;
  }
  interface FastifyRequest {
    /** Set only when the request authenticated with an API key (never with a login JWT). */
    apiKeyId?: string;
  }
}
