export interface JwtPayload {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "viewer";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
