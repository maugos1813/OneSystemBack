import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, getCurrentUser, registerOrganizationWithOwner } from "../../services/auth.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const registerSchema = z.object({
  orgName: z.string().min(2).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Postgres unique_violation error code; pg's driver attaches it as `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const { orgId, user } = await registerOrganizationWithOwner(parsed.data);
      const token = app.jwt.sign({ userId: user.id, orgId, role: user.role });
      return reply.code(201).send({ token });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "Email already registered" });
      }
      throw err;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const user = await authenticate(parsed.data.email, parsed.data.password);
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ userId: user.id, orgId: user.orgId, role: user.role });
    return reply.send({ token });
  });

  app.get("/me", { onRequest: requireAuth }, async (request, reply) => {
    const me = await getCurrentUser(request.user.userId);
    if (!me) return reply.code(404).send({ error: "User not found" });
    return me;
  });
}
