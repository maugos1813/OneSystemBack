import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { authenticate, getCurrentUser } from "../../services/auth.service.js";
import { getOrganizationBrief, isPlatformUser } from "../../services/platform.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { rateLimitLogin } from "../middlewares/loginRateLimit.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Accounts are opened by OneSystec (Clientes, in the app), never by the public: this stays answering so old callers get a clear no.
  app.post(
    "/auth/register",
    { schema: { tags: ["Auth"], summary: "Cerrado: las cuentas las crea OneSystec", hide: true } },
    async (_request, reply) => reply.code(403).send({ error: "Registration is closed: accounts are created by OneSystec" }),
  );

  app.post(
    "/auth/login",
    {
      preHandler: rateLimitLogin,
      schema: {
        tags: ["Auth"],
        summary: "Iniciar sesión y obtener un JWT",
        body: zodToJsonSchema(loginSchema),
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const user = await authenticate(parsed.data.email, parsed.data.password);
      if (!user) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = app.jwt.sign({
        userId: user.id,
        orgId: user.orgId,
        role: user.role,
        allowedArea: user.allowedArea,
      });
      return reply.send({ token });
    },
  );

  app.get(
    "/me",
    {
      onRequest: requireAuth,
      schema: {
        tags: ["Auth"],
        summary: "Datos del usuario y organización autenticados",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const me = await getCurrentUser(request.user.userId);
      if (!me) return reply.code(404).send({ error: "User not found" });
      const isPlatform = await isPlatformUser(me.userId);
      // OneSystec looking at a client: the account answers as that client's, and says so.
      if (request.user.viewAs && isPlatform) {
        const org = await getOrganizationBrief(request.user.orgId);
        if (org) {
          return {
            ...me,
            role: "admin" as const,
            orgId: org.id,
            orgName: org.name,
            orgLogo: org.logo,
            isPlatform,
            viewingAs: { orgId: org.id, orgName: org.name },
          };
        }
      }
      return { ...me, isPlatform };
    },
  );
}
