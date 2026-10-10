import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { DEFAULT_SPEED_LIMIT_KMH, getDrivingStyle } from "../../services/drivingStyle.service.js";
import { getDeviceEvents, getPositionHistory } from "../../services/position.service.js";
import { listPublicVehicles, toPublicEvent, toPublicPosition } from "../../services/publicVehicle.service.js";
import { getVehicleForOrg } from "../../services/vehicle.service.js";
import { requireApiKey } from "../middlewares/auth.middleware.js";
import { rateLimitApiKey } from "../middlewares/rateLimit.js";

/**
 * The public, READ-ONLY API that other apps integrate against (Authorization: Bearer
 * <API key>). Only GET routes are registered here, and API keys are additionally refused
 * on every non-GET request at the auth layer — so no integration can ever write vehicle data.
 */

const DOC_SECURITY = [{ apiKeyAuth: [] }];

const positionSchema = {
  type: "object",
  properties: {
    ts: { type: "string", format: "date-time" },
    lat: { type: "number" },
    lng: { type: "number" },
    speed: { type: "number", description: "km/h" },
    angle: { type: "number", description: "Heading in degrees (0-360)" },
    altitude: { type: "number", description: "meters" },
    satellites: { type: "number", nullable: true },
    ignition: { type: "boolean", nullable: true, description: "null if the source doesn't report it" },
    ioData: { type: "object", additionalProperties: true, description: "Raw device IO elements (AVL ID -> value)" },
  },
} as const;

const vehicleSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    plate: { type: "string", nullable: true },
    fleetGroup: { type: "string", nullable: true },
    lastPosition: { ...positionSchema, nullable: true },
  },
} as const;

const scoresSchema = {
  type: "object",
  properties: {
    overall: { type: "number" },
    harshBraking: { type: "number" },
    harshAcceleration: { type: "number" },
    harshCornering: { type: "number" },
    speeding: { type: "number" },
    grade: { type: "string", enum: ["A+", "A", "B", "C", "D"] },
  },
} as const;

const countsSchema = {
  type: "object",
  properties: {
    harshBraking: { type: "integer" },
    harshAcceleration: { type: "integer" },
    harshCornering: { type: "integer" },
    speeding: { type: "integer" },
  },
} as const;

const vehicleStyleSchema = {
  type: "object",
  properties: {
    vehicleId: { type: "string", format: "uuid" },
    name: { type: "string" },
    plate: { type: "string", nullable: true },
    fleetGroup: { type: "string", nullable: true },
    samples: { type: "integer", description: "GPS reports analysed. 0 = no data (not perfect driving)." },
    scores: { ...scoresSchema, nullable: true },
    incidents: countsSchema,
  },
} as const;

const periodProperties = {
  days: { type: "integer" },
  speedLimitKmh: { type: "number" },
  from: { type: "string", format: "date-time" },
  to: { type: "string", format: "date-time" },
} as const;

const errorSchema = { type: "object", additionalProperties: true } as const;
const ERRORS = { 400: errorSchema, 404: errorSchema } as const;

const idParams = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const styleQuery = z.object({
  days: z.coerce.number().int().min(1).max(31).default(7),
  speedLimit: z.coerce.number().min(10).max(300).default(DEFAULT_SPEED_LIMIT_KMH),
});

const rangeQueryDoc = {
  type: "object",
  properties: {
    from: { type: "string", format: "date-time", description: "ISO 8601, inclusive" },
    to: { type: "string", format: "date-time", description: "ISO 8601, inclusive" },
    limit: { type: "integer", minimum: 1, maximum: 5000, description: "Default 500, newest first" },
  },
} as const;

const styleQueryDoc = {
  type: "object",
  properties: {
    days: { type: "integer", minimum: 1, maximum: 31, default: 7, description: "Window ending now" },
    speedLimit: {
      type: "number",
      minimum: 10,
      maximum: 300,
      default: DEFAULT_SPEED_LIMIT_KMH,
      description: "km/h above which a stretch counts as speeding",
    },
  },
} as const;

const DOCS_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OneSystec API v1</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/v1/openapi.json", dom_id: "#ui", persistAuthorization: true });
    </script>
  </body>
</html>`;

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // A second, independent OpenAPI document that only sees the routes of this plugin.
  await app.register(swagger, {
    decorator: "swaggerPublic",
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "OneSystec API v1 (solo lectura)",
        description:
          "Datos de los vehículos de tu organización para integrarlos en otras apps. **Solo lectura**: " +
          "no existe ninguna operación que cree, modifique o borre datos. Autenticación con una API key " +
          "(se crea en OneTrack > API Keys) en el header `Authorization: Bearer osk_live_...`. " +
          `Límite: ${env.PUBLIC_API_RATE_LIMIT_PER_MIN} peticiones por minuto por key.`,
        version: "1.0.0",
      },
      servers: [{ url: env.PUBLIC_API_URL, description: "API" }],
      tags: [
        { name: "Vehículos", description: "Vehículos y su última posición" },
        { name: "Posiciones", description: "Histórico de posiciones y eventos" },
        { name: "Estilo de conducción", description: "Puntajes de manejo (1-100) por vehículo" },
      ],
      components: {
        securitySchemes: {
          apiKeyAuth: { type: "http", scheme: "bearer", description: "API key de tu organización (osk_live_...)" },
        },
      },
    },
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swaggerPublic());
  app.get("/docs", { schema: { hide: true } }, async (_request, reply) => reply.type("text/html").send(DOCS_HTML));

  await app.register(async (secured) => {
    secured.addHook("onRequest", requireApiKey);
    secured.addHook("onRequest", rateLimitApiKey);

    secured.get(
      "/vehicles",
      {
        schema: {
          tags: ["Vehículos"],
          summary: "Vehículos de la organización, cada uno con su última posición",
          security: DOC_SECURITY,
          response: { 200: { type: "array", items: vehicleSchema }, ...ERRORS },
        },
      },
      async (request) => listPublicVehicles(request.user.orgId),
    );

    secured.get(
      "/vehicles/:id",
      {
        schema: {
          tags: ["Vehículos"],
          summary: "Un vehículo con su última posición",
          security: DOC_SECURITY,
          params: idParams,
          response: { 200: vehicleSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const [vehicle] = await listPublicVehicles(request.user.orgId, id);
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        return vehicle;
      },
    );

    secured.get(
      "/vehicles/:id/positions/latest",
      {
        schema: {
          tags: ["Posiciones"],
          summary: "Última posición conocida de un vehículo",
          security: DOC_SECURITY,
          params: idParams,
          response: { 200: positionSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const [vehicle] = await listPublicVehicles(request.user.orgId, id);
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        if (!vehicle.lastPosition) return reply.code(404).send({ error: "No positions recorded yet" });
        return vehicle.lastPosition;
      },
    );

    secured.get(
      "/vehicles/:id/positions",
      {
        schema: {
          tags: ["Posiciones"],
          summary: "Histórico de posiciones de un vehículo (más recientes primero)",
          security: DOC_SECURITY,
          params: idParams,
          querystring: rangeQueryDoc,
          response: { 200: { type: "array", items: positionSchema }, ...ERRORS },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = rangeQuery.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

        const vehicle = await getVehicleForOrg(request.user.orgId, id);
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        if (!vehicle.deviceId) return [];

        return (await getPositionHistory({ deviceId: vehicle.deviceId, ...parsed.data })).map(toPublicPosition);
      },
    );

    secured.get(
      "/vehicles/:id/events",
      {
        schema: {
          tags: ["Posiciones"],
          summary: "Eventos del vehículo (cambios de ignición y de movimiento)",
          security: DOC_SECURITY,
          params: idParams,
          querystring: rangeQueryDoc,
          response: {
            200: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ts: { type: "string", format: "date-time" },
                  type: { type: "string" },
                  payload: { type: "object", additionalProperties: true },
                },
              },
            },
            ...ERRORS,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = rangeQuery.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

        const vehicle = await getVehicleForOrg(request.user.orgId, id);
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        if (!vehicle.deviceId) return [];

        return (await getDeviceEvents({ deviceId: vehicle.deviceId, ...parsed.data })).map(toPublicEvent);
      },
    );

    secured.get(
      "/driving-style",
      {
        schema: {
          tags: ["Estilo de conducción"],
          summary: "Puntajes de estilo de conducción de toda la flota",
          description:
            "Cada puntaje va de 1 a 100 (100 = sin incidentes; cada incidente resta 6 puntos, mínimo 1). " +
            "`overall` es el promedio de las cuatro categorías. Un tramo continuo sobre el límite de velocidad " +
            "cuenta como un solo incidente. Los resultados se cachean 5 minutos.",
          security: DOC_SECURITY,
          querystring: styleQueryDoc,
          response: {
            200: { type: "object", properties: { ...periodProperties, vehicles: { type: "array", items: vehicleStyleSchema } } },
            ...ERRORS,
          },
        },
      },
      async (request, reply) => {
        const parsed = styleQuery.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
        return getDrivingStyle({ orgId: request.user.orgId, days: parsed.data.days, speedLimitKmh: parsed.data.speedLimit });
      },
    );

    secured.get(
      "/vehicles/:id/driving-style",
      {
        schema: {
          tags: ["Estilo de conducción"],
          summary: "Puntajes de estilo de conducción de un vehículo",
          security: DOC_SECURITY,
          params: idParams,
          querystring: styleQueryDoc,
          response: { 200: { type: "object", properties: { ...periodProperties, ...vehicleStyleSchema.properties } }, ...ERRORS },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = styleQuery.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

        const result = await getDrivingStyle({
          orgId: request.user.orgId,
          vehicleId: id,
          days: parsed.data.days,
          speedLimitKmh: parsed.data.speedLimit,
        });
        const [vehicle] = result.vehicles;
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        return { days: result.days, speedLimitKmh: result.speedLimitKmh, from: result.from, to: result.to, ...vehicle };
      },
    );
  });
}
