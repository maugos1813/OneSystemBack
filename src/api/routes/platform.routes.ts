import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { logoSchema } from "../../services/orgLogo.js";
import { createClientOrganization, getOrganizationBrief, getOrganizationDetail, listOrganizations } from "../../services/platform.service.js";
import { requireAuth, requirePlatform } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const PLATFORM = { onRequest: requireAuth, preHandler: requirePlatform };

const createClientSchema = z.object({
  orgName: z.string().min(2).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  logo: logoSchema.optional(),
});

/** Cross-client administration. Only OneSystec's own organization gets past `requirePlatform`; clients never see these. */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/platform/organizations",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Todas las organizaciones (solo OneSystec)", security: AUTH } },
    async () => listOrganizations(),
  );

  app.get<{ Params: { id: string } }>(
    "/platform/organizations/:id",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Detalle de una organización (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid id" });
      const detail = await getOrganizationDetail(parsed.data);
      if (!detail) return reply.code(404).send({ error: "Organization not found" });
      return detail;
    },
  );

  // "See the client's map in one click": a short-lived token that carries the client's organization but only lets OneSystec read.
  app.post<{ Params: { id: string } }>(
    "/platform/organizations/:id/view",
    {
      ...PLATFORM,
      schema: { tags: ["Platform"], summary: "Token de solo lectura para ver la cuenta de un cliente (solo OneSystec)", security: AUTH },
    },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid id" });
      const org = await getOrganizationBrief(parsed.data);
      if (!org) return reply.code(404).send({ error: "Organization not found" });
      const token = app.jwt.sign(
        { userId: request.user.userId, orgId: org.id, role: "admin", allowedArea: null, viewAs: true },
        { expiresIn: "2h" },
      );
      return { token, orgId: org.id, orgName: org.name };
    },
  );

  app.post(
    "/platform/organizations",
    {
      ...PLATFORM,
      schema: {
        tags: ["Platform"],
        summary: "Dar de alta un cliente nuevo con su primer usuario (solo OneSystec)",
        security: AUTH,
        body: zodToJsonSchema(createClientSchema),
      },
    },
    async (request, reply) => {
      const parsed = createClientSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const { orgId, user } = await createClientOrganization(parsed.data);
        return reply.code(201).send({ orgId, userId: user.id });
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
          return reply.code(409).send({ error: "Email already registered" });
        }
        throw err;
      }
    },
  );
}
