import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createGeofence,
  deleteGeofence,
  listGeofencesForOrg,
  updateGeofence,
} from "../../services/geofence.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

const circleSchema = z.object({
  type: z.literal("circle"),
  name: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(50_000),
  alertOnEnter: z.boolean().optional(),
  alertOnExit: z.boolean().optional(),
});

// Rings, not just one — a single geofence can cover several disjoint areas (e.g. official
// zone boundaries like Milan's Area B, which includes a few small exclaves).
const polygonSchema = z.object({
  type: z.literal("polygon"),
  name: z.string().min(1).max(100),
  path: z.array(z.array(pointSchema).min(3)).min(1).max(20),
  alertOnEnter: z.boolean().optional(),
  alertOnExit: z.boolean().optional(),
});

const createSchema = z.discriminatedUnion("type", [circleSchema, polygonSchema]);

// Geometry (lat/lng/radius, path) is set once at creation and not editable afterwards —
// covers the existing drag/resize-a-circle flow plus renaming/toggling alerts on any type.
const updateSchema = z.object({
  name: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(10).max(50_000),
  alertOnEnter: z.boolean(),
  alertOnExit: z.boolean(),
}).partial();

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const MANAGE_GEOFENCES = requireRole("owner", "admin");

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
      preHandler: MANAGE_GEOFENCES,
      schema: {
        tags: ["Geofences"],
        summary: "Crear una geocerca, circular (centro + radio) o poligonal (owner/admin)",
        security: AUTH,
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const { type, name, alertOnEnter, alertOnExit } = parsed.data;
      const geofence = await createGeofence({
        orgId: request.user.orgId,
        name,
        alertOnEnter,
        alertOnExit,
        type,
        lat: type === "circle" ? parsed.data.lat : null,
        lng: type === "circle" ? parsed.data.lng : null,
        radiusMeters: type === "circle" ? parsed.data.radiusMeters : null,
        path: type === "polygon" ? parsed.data.path : null,
      });
      return reply.code(201).send(geofence);
    },
  );

  app.patch(
    "/geofences/:id",
    {
      preHandler: MANAGE_GEOFENCES,
      schema: {
        tags: ["Geofences"],
        summary: "Editar una geocerca (owner/admin)",
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
    {
      preHandler: MANAGE_GEOFENCES,
      schema: { tags: ["Geofences"], summary: "Eliminar una geocerca (owner/admin)", security: AUTH },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteGeofence(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "Geofence not found" });
      return reply.code(204).send();
    },
  );
}
