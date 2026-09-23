import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createGeofence,
  deleteGeofence,
  listGeofencesForOrg,
  updateGeofence,
} from "../../services/geofence.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(50_000),
  alertOnEnter: z.boolean().optional(),
  alertOnExit: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export async function geofencesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/geofences",
    { schema: { tags: ["Geofences"], summary: "Listar geocercas", security: AUTH } },
    async (request) => {
      return listGeofencesForOrg(request.user.orgId);
    },
  );

  app.post(
    "/geofences",
    {
      schema: {
        tags: ["Geofences"],
        summary: "Crear una geocerca circular (centro + radio)",
        security: AUTH,
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const geofence = await createGeofence({ ...parsed.data, orgId: request.user.orgId });
      return reply.code(201).send(geofence);
    },
  );

  app.patch(
    "/geofences/:id",
    {
      schema: {
        tags: ["Geofences"],
        summary: "Editar una geocerca",
        security: AUTH,
        body: zodToJsonSchema(updateSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const geofence = await updateGeofence(request.user.orgId, id, parsed.data);
      if (!geofence) return reply.code(404).send({ error: "Geofence not found" });
      return geofence;
    },
  );

  app.delete(
    "/geofences/:id",
    { schema: { tags: ["Geofences"], summary: "Eliminar una geocerca", security: AUTH } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteGeofence(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "Geofence not found" });
      return reply.code(204).send();
    },
  );
}
