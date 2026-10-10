import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ApiKey } from "../../db/schema/index.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../../services/apiKey.service.js";
import { fleetGroupExists } from "../../services/vehicle.service.js";
import { requireRole } from "../middlewares/auth.middleware.js";

const createSchema = z.object({
  name: z.string().min(2).max(100),
  // Limit the key to one área (e.g. "DHL"). Omitted/null = full access to the whole fleet.
  allowedArea: z.string().min(1).max(50).nullable().optional(),
});

/** The key's hash is never sent back to the client. */
function serializeApiKey(key: ApiKey) {
  return {
    id: key.id,
    orgId: key.orgId,
    name: key.name,
    allowedArea: key.allowedArea,
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
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["API Keys"],
        summary: "Listar las API keys de tu organización (owner/admin)",
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
      // An API key authenticates as full owner-level access (see apiKey.service.ts),
      // ignoring role and área restrictions entirely — a restricted viewer/manager
      // minting one for itself would be a direct privilege-escalation path.
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["API Keys"],
        summary: "Crear una API key nueva (el valor completo solo se muestra esta vez) (owner/admin)",
        security: [{ bearerAuth: [] }],
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      // A user who is themselves limited to an área can only mint keys for that same área.
      const allowedArea = request.user.allowedArea ?? parsed.data.allowedArea ?? null;
      if (parsed.data.allowedArea && request.user.allowedArea && parsed.data.allowedArea !== request.user.allowedArea) {
        return reply.code(403).send({ error: "You can only create keys for your own área" });
      }
      // An área that matches no vehicle would silently produce a key that sees nothing.
      if (allowedArea && !(await fleetGroupExists(request.user.orgId, allowedArea))) {
        return reply.code(400).send({ error: `Unknown área "${allowedArea}"` });
      }

      const { record, plaintextKey } = await createApiKey(request.user.orgId, parsed.data.name, allowedArea);
      // The plaintext key is only ever sent this one time — the server never stores it.
      return reply.code(201).send({ ...serializeApiKey(record), key: plaintextKey });
    },
  );

  app.delete(
    "/api-keys/:id",
    {
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["API Keys"],
        summary: "Revocar una API key (owner/admin)",
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
