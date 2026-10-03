import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listTollPassages, setTollPassageFlagged } from "../../services/toll.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

const listQuerySchema = z.object({
  vehicleId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  flaggedOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const flagSchema = z.object({ flagged: z.boolean() });

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
// Deciding which passages count as unauthorized is an owner/admin call, like the other
// org-wide settings.
const MANAGE_TOLLS = requireRole("owner", "admin");

export async function tollsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/tolls/passages",
    {
      schema: {
        tags: ["Tolls"],
        summary: "Pasos por peaje detectados (últimos 7 días por defecto)",
        security: AUTH,
        querystring: {
          type: "object",
          properties: {
            vehicleId: { type: "string", format: "uuid" },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            flaggedOnly: { type: "string", enum: ["true", "false"] },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            offset: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      return listTollPassages({
        ...parsed.data,
        orgId: request.user.orgId,
        allowedArea: request.user.allowedArea,
        from: parsed.data.from ?? new Date(Date.now() - DEFAULT_RANGE_MS),
      });
    },
  );

  app.patch(
    "/tolls/passages/:id",
    {
      preHandler: MANAGE_TOLLS,
      schema: {
        tags: ["Tolls"],
        summary: "Marcar o desmarcar un paso por peaje como indebido (owner/admin)",
        security: AUTH,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = flagSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await setTollPassageFlagged(
        request.user.orgId,
        id,
        parsed.data.flagged,
        request.user.allowedArea,
      );
      if (!updated) return reply.code(404).send({ error: "Toll passage not found" });
      return { id, flagged: parsed.data.flagged };
    },
  );
}
