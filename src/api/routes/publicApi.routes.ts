import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { getApiKey } from "../../services/apiKey.service.js";
import { DEFAULT_SPEED_LIMIT_KMH, DRIVING_RULES, getDrivingStyle } from "../../services/drivingStyle.service.js";
import { MAX_WINDOW_DAYS, resolveDrivingWindow } from "../../services/drivingWindow.js";
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

const nullableInt = { type: "integer", nullable: true } as const;
const nullableNumber = { type: "number", nullable: true } as const;

const scoresSchema = {
  type: "object",
  nullable: true,
  description: "1-100 (100 = sin incidentes). null si no hay datos suficientes (ver `quality`).",
  properties: {
    overall: { type: "number" },
    harshBraking: nullableNumber,
    harshAcceleration: nullableNumber,
    harshCornering: nullableNumber,
    speeding: { type: "number" },
    grade: { type: "string", enum: ["A+", "A", "B", "C", "D"] },
  },
} as const;

const vehicleStyleProperties = {
  vehicleId: { type: "string", format: "uuid" },
  name: { type: "string" },
  plate: { type: "string", nullable: true },
  fleetGroup: { type: "string", nullable: true },
  samples: { type: "integer", description: "Reportes GPS analizados. 0 = sin datos (no significa manejo perfecto)." },
  distanceKm: { type: "number", description: "Distancia recorrida en el periodo" },
  drivingHours: { type: "number", description: "Horas en movimiento" },
  trips: { type: "integer" },
  quality: {
    type: "string",
    enum: ["full", "speeding_only", "insufficient_data", "no_data"],
    description:
      "full: todos los puntajes. speeding_only: el dispositivo reporta muy espaciado para detectar frenadas/aceleraciones/giros bruscos, solo se puntúa la velocidad. " +
      "insufficient_data: menos de 20 km en el periodo. no_data: sin reportes.",
  },
  scores: scoresSchema,
  incidents: {
    type: "object",
    description: "Cantidad de incidentes. null en las categorías que no se pueden detectar.",
    properties: {
      harshBraking: nullableInt,
      harshAcceleration: nullableInt,
      harshCornering: nullableInt,
      speeding: { type: "integer" },
    },
  },
  incidentsPer100Km: {
    type: "object",
    nullable: true,
    description: "Incidentes por cada 100 km recorridos: es la base de los puntajes.",
    properties: {
      harshBraking: nullableNumber,
      harshAcceleration: nullableNumber,
      harshCornering: nullableNumber,
      speeding: { type: "number" },
    },
  },
} as const;

const vehicleStyleSchema = { type: "object", properties: vehicleStyleProperties } as const;

const rulesSchema = {
  type: "object",
  description: "Reglas con las que se calculó (umbrales físicos y escala de puntos).",
  properties: {
    harshBrakingMs2: { type: "number" },
    harshAccelerationMs2: { type: "number" },
    harshCorneringMs2: { type: "number" },
    speedingMinSeconds: { type: "number" },
    pointsPerIncidentPer100Km: { type: "number" },
    minDistanceKm: { type: "number" },
  },
} as const;

const periodProperties = {
  days: { type: "integer", nullable: true, description: "Días pedidos con `days`; null si se pidió un tramo exacto con `from`/`to`" },
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
    days: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WINDOW_DAYS,
      default: 7,
      description:
        "Ventana de los últimos N días, terminando ahora. **Se ignora si envías `from` y `to`** " +
        "(si lo incluyes junto a ellos debe seguir siendo un valor válido).",
    },
    from: {
      type: "string",
      format: "date-time",
      description:
        "Inicio exacto del tramo (ISO 8601, inclusive), p. ej. el inicio del turno de un chofer. " +
        "Debe enviarse junto con `to`; entonces reemplaza a `days`.",
    },
    to: {
      type: "string",
      format: "date-time",
      description:
        "Fin exacto del tramo (ISO 8601, inclusive). Si está en el futuro se recorta a \"ahora\". " +
        `Debe ser posterior a \`from\` y el tramo no puede superar ${MAX_WINDOW_DAYS} días. ` +
        "Solo cuentan las posiciones dentro del tramo: un incidente que empiece fuera no se cuenta, y un exceso de " +
        "velocidad que cruce el borde se evalúa solo con la parte de dentro.",
    },
    speedLimit: {
      type: "number",
      minimum: 10,
      maximum: 300,
      default: DEFAULT_SPEED_LIMIT_KMH,
      description: "km/h above which a stretch counts as speeding",
    },
  },
} as const;

const WINDOW_DOC =
  "**Tramo exacto:** con `from` y `to` se calcula solo ese intervalo (útil para puntuar a un chofer en su horario). " +
  "`from` y `to` van siempre juntos, `from` < `to`, máximo 31 días; el rango efectivo se devuelve en `from`/`to`. " +
  "**Datos crudos:** `incidents`, `distanceKm`, `drivingHours`, `trips`, `samples` y `quality` se devuelven siempre, " +
  "aunque `scores` sea null (p. ej. `insufficient_data` por menos de 20 km): así puedes sumar incidentes y km de varios " +
  "tramos y calcular el puntaje con la misma fórmula. Una categoría que el dispositivo no puede detectar viene como null. ";

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
        { name: "Acceso", description: "Qué puede ver la API key que estás usando" },
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
      "/key",
      {
        schema: {
          tags: ["Acceso"],
          summary: "Alcance de la API key que estás usando",
          description:
            "`access: \"all\"` = ve toda la flota de la organización. `access: \"area\"` = solo ve los vehículos de `area`.",
          security: DOC_SECURITY,
          response: {
            200: {
              type: "object",
              properties: {
                name: { type: "string" },
                keyPrefix: { type: "string" },
                access: { type: "string", enum: ["all", "area"] },
                area: { type: "string", nullable: true },
              },
            },
            ...ERRORS,
          },
        },
      },
      async (request, reply) => {
        const key = await getApiKey(request.apiKeyId!);
        if (!key) return reply.code(404).send({ error: "API key not found" });
        return { name: key.name, keyPrefix: key.keyPrefix, access: key.allowedArea ? "area" : "all", area: key.allowedArea };
      },
    );

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
      async (request) => listPublicVehicles(request.user.orgId, { allowedArea: request.user.allowedArea }),
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
        const [vehicle] = await listPublicVehicles(request.user.orgId, { vehicleId: id, allowedArea: request.user.allowedArea });
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
        const [vehicle] = await listPublicVehicles(request.user.orgId, { vehicleId: id, allowedArea: request.user.allowedArea });
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

        const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
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

        const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
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
            "Cada puntaje va de 1 a 100 (100 = sin incidentes). Se calcula por cada 100 km recorridos —cada incidente " +
            `por 100 km resta ${DRIVING_RULES.pointsPerIncidentPer100Km} puntos, mínimo 1—, así que un vehículo que maneja mucho ` +
            "no se penaliza frente a uno que maneja poco. Frenadas, aceleraciones y giros bruscos se detectan por su " +
            "aceleración física (m/s²); un exceso de velocidad cuenta si se mantiene al menos " +
            `${DRIVING_RULES.speedingMinSeconds} s. \`overall\` es el promedio de las categorías disponibles. ` +
            "Revisa `quality` antes de usar los puntajes. " +
            WINDOW_DOC +
            "Los resultados se cachean 5 minutos (1 hora si el tramo `to` terminó hace más de 10 minutos).",
          security: DOC_SECURITY,
          querystring: styleQueryDoc,
          response: {
            200: {
              type: "object",
              properties: { ...periodProperties, rules: rulesSchema, vehicles: { type: "array", items: vehicleStyleSchema } },
            },
            ...ERRORS,
          },
        },
      },
      async (request, reply) => {
        const resolved = resolveDrivingWindow(request.query);
        if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
        const { window } = resolved;
        const result = await getDrivingStyle({
          orgId: request.user.orgId,
          allowedArea: request.user.allowedArea,
          days: window.days,
          from: window.from,
          to: window.to,
          speedLimitKmh: window.speedLimitKmh,
        });
        return { ...result, rules: DRIVING_RULES };
      },
    );

    secured.get(
      "/vehicles/:id/driving-style",
      {
        schema: {
          tags: ["Estilo de conducción"],
          summary: "Puntajes de estilo de conducción de un vehículo",
          description:
            "Mismas reglas y fórmula que `/v1/driving-style`, para un solo vehículo. " +
            WINDOW_DOC +
            "Los resultados se cachean 5 minutos (1 hora si el tramo `to` terminó hace más de 10 minutos).",
          security: DOC_SECURITY,
          params: idParams,
          querystring: styleQueryDoc,
          response: { 200: { type: "object", properties: { ...periodProperties, rules: rulesSchema, ...vehicleStyleProperties } }, ...ERRORS },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const resolved = resolveDrivingWindow(request.query);
        if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
        const { window } = resolved;

        const result = await getDrivingStyle({
          orgId: request.user.orgId,
          allowedArea: request.user.allowedArea,
          vehicleId: id,
          days: window.days,
          from: window.from,
          to: window.to,
          speedLimitKmh: window.speedLimitKmh,
        });
        const [vehicle] = result.vehicles;
        if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
        return { days: result.days, speedLimitKmh: result.speedLimitKmh, from: result.from, to: result.to, rules: DRIVING_RULES, ...vehicle };
      },
    );
  });
}
