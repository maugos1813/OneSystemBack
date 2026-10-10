import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_SPEED_LIMIT_KMH,
  DRIVING_RULES,
  getDrivingStyle,
  getVehicleIncidents,
} from "../../services/drivingStyle.service.js";
import { getVehicleForOrg } from "../../services/vehicle.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

/** Feeds the app's Conducción page. Same calculation as the public /v1 API (one
 * implementation), but behind the user's login so the área restriction applies. */

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const query = z.object({
  days: z.coerce.number().int().min(1).max(31).default(7),
  // Start of the window (e.g. "since midnight" for the Cockpit); overrides `days`.
  from: z.coerce
    .date()
    .refine((d) => Date.now() - d.getTime() <= MAX_WINDOW_MS && d.getTime() <= Date.now(), "from must be within the last 31 days")
    .optional(),
  speedLimit: z.coerce.number().min(10).max(300).default(DEFAULT_SPEED_LIMIT_KMH),
});

const queryDoc = {
  type: "object",
  properties: {
    days: { type: "integer", minimum: 1, maximum: 31, default: 7 },
    from: { type: "string", format: "date-time", description: "Inicio de la ventana (hasta 31 días atrás); reemplaza a `days`" },
    speedLimit: { type: "number", minimum: 10, maximum: 300, default: DEFAULT_SPEED_LIMIT_KMH },
  },
} as const;

export async function drivingStyleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/driving-style",
    {
      schema: {
        tags: ["Driving"],
        summary: "Puntajes de estilo de conducción de la flota que ves (por área)",
        security: AUTH,
        querystring: queryDoc,
      },
    },
    async (request, reply) => {
      const parsed = query.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const result = await getDrivingStyle({
        orgId: request.user.orgId,
        allowedArea: request.user.allowedArea,
        days: parsed.data.days,
        from: parsed.data.from,
        speedLimitKmh: parsed.data.speedLimit,
      });
      return { ...result, rules: DRIVING_RULES };
    },
  );

  app.get(
    "/vehicles/:id/driving-style/incidents",
    {
      schema: {
        tags: ["Driving"],
        summary: "Dónde y cuándo ocurrió cada incidente de un vehículo (los 500 más recientes)",
        security: AUTH,
        querystring: queryDoc,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = query.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      if (!vehicle.deviceId) return { incidents: [] };

      return { incidents: await getVehicleIncidents(vehicle.deviceId, parsed.data.days, parsed.data.speedLimit) };
    },
  );
}
