import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { removeToken, saveToken } from "../../services/push.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

const tokenSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(["android", "ios", "web"]).default("android"),
});
const removeSchema = z.object({ token: z.string().min(20).max(4096) });

export async function pushTokensRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  // Only a signed-in person has a phone to notify; an API key does not.
  app.addHook("preHandler", async (request, reply) => {
    if (request.apiKeyId) await reply.code(403).send({ error: "Forbidden" });
  });

  app.post(
    "/push-tokens",
    { schema: { tags: ["Push"], summary: "Registrar este teléfono para recibir notificaciones", security: AUTH, body: zodToJsonSchema(tokenSchema) } },
    async (request, reply) => {
      const parsed = tokenSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await saveToken(request.user.userId, request.user.orgId, parsed.data.token, parsed.data.platform);
      return reply.code(204).send();
    },
  );

  app.post(
    "/push-tokens/unregister",
    { schema: { tags: ["Push"], summary: "Dejar de recibir notificaciones en este teléfono", security: AUTH, body: zodToJsonSchema(removeSchema) } },
    async (request, reply) => {
      const parsed = removeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await removeToken(request.user.userId, parsed.data.token);
      return reply.code(204).send();
    },
  );
}
