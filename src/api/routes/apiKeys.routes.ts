import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ApiKey } from "../../db/schema/index.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../../services/apiKey.service.js";

const createSchema = z.object({ name: z.string().min(2).max(100) });

/** The key's hash is never sent back to the client. */
function serializeApiKey(key: ApiKey) {
  return {
    id: key.id,
    orgId: key.orgId,
    name: key.name,
    keyPrefix: key.keyPrefix,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}

/** Only a logged-in user (JWT) may manage API keys — a leaked key should never be able
 * to mint more keys for itself. */
async function requireUserAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

export async function apiKeysRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireUserAuth);

  app.get(
    "/api-keys",
    {
      schema: {
        tags: ["API Keys"],
        summary: "Listar las API keys de tu organización",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const keys = await listApiKeys(request.user.orgId);
      return keys.map(serializeApiKey);
    },
  );

  app.post(
    "/api-keys",
    {
      schema: {
        tags: ["API Keys"],
        summary: "Crear una API key nueva (el valor completo solo se muestra esta vez)",
        security: [{ bearerAuth: [] }],
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const { record, plaintextKey } = await createApiKey(request.user.orgId, parsed.data.name);
      // The plaintext key is only ever sent this one time — the server never stores it.
      return reply.code(201).send({ ...serializeApiKey(record), key: plaintextKey });
    },
  );

  app.delete(
    "/api-keys/:id",
    {
      schema: {
        tags: ["API Keys"],
        summary: "Revocar una API key",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revoked = await revokeApiKey(request.user.orgId, id);
      if (!revoked) return reply.code(404).send({ error: "API key not found" });
      return reply.code(204).send();
    },
  );
}
