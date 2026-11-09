import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDeviceEvents,
  getLatestPosition,
  getLatestPositionsForDevices,
  getPositionHistory,
} from "../../services/position.service.js";
import { getVehicleDeviceWindows } from "../../services/vehicleAssignment.service.js";
import { getVehicleForOrg, listVehiclesForOrg } from "../../services/vehicle.service.js";
import { requireAuth, requireModule } from "../middlewares/auth.middleware.js";

const historyQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  maxPoints: z.coerce.number().int().min(2).max(5000).optional(),
});

const eventsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const rangeQueryJsonSchema = {
  type: "object",
  properties: {
    from: { type: "string", format: "date-time", description: "ISO 8601, inclusive" },
    to: { type: "string", format: "date-time", description: "ISO 8601, inclusive" },
    limit: { type: "integer", minimum: 1 },
    maxPoints: { type: "integer", minimum: 2, description: "Reparte hasta este número de puntos por todo el rango (conserva los picos de velocidad)" },
  },
};

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export async function positionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // The live map's starting point: the last position of every vehicle the caller may see, in one answer (it used to be one request per
  // vehicle, each with its own authentication and lookups). The área restriction applies exactly as in the vehicle list.
  app.get(
    "/positions/latest",
    {
      schema: {
        tags: ["Positions"],
        summary: "Última posición conocida de todos los vehículos que puedes ver, por id de vehículo",
        security: AUTH,
      },
    },
    async (request) => {
      const vehicles = (await listVehiclesForOrg(request.user.orgId, request.user.allowedArea)).filter((vehicle) => vehicle.deviceId);
      const byDevice = await getLatestPositionsForDevices(vehicles.map((vehicle) => vehicle.deviceId!));
      const out: Record<string, unknown> = {};
      for (const vehicle of vehicles) {
        const position = byDevice.get(vehicle.deviceId!);
        if (position) out[vehicle.id] = position;
      }
      return out;
    },
  );

  app.get(
    "/vehicles/:id/positions/latest",
    {
      schema: {
        tags: ["Positions"],
        summary: "Última posición conocida de un vehículo",
        security: AUTH,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      if (!vehicle.deviceId) return reply.code(404).send({ error: "Vehicle has no device assigned" });

      const position = await getLatestPosition(vehicle.deviceId);
      if (!position) return reply.code(404).send({ error: "No positions recorded yet" });
      return position;
    },
  );

  app.get(
    "/vehicles/:id/positions",
    {
      // The history behind Historial; the live map only needs /latest.
      preHandler: requireModule("historial"),
      schema: {
        tags: ["Positions"],
        summary: "Histórico de posiciones de un vehículo, por rango de fechas",
        security: AUTH,
        querystring: rangeQueryJsonSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      // The vehicle's history is what each device it carried recorded while it was on it, so a change of device keeps the route.
      const windows = await getVehicleDeviceWindows(vehicle.id, vehicle.deviceId);
      if (windows.length === 0) return reply.code(404).send({ error: "Vehicle has no device assigned" });

      return getPositionHistory({ windows, ...parsed.data });
    },
  );

  app.get(
    "/vehicles/:id/events",
    {
      schema: {
        tags: ["Positions"],
        summary: "Eventos (ignición/movimiento) de un vehículo, por rango de fechas",
        security: AUTH,
        querystring: rangeQueryJsonSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = eventsQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      const windows = await getVehicleDeviceWindows(vehicle.id, vehicle.deviceId);
      if (windows.length === 0) return reply.code(404).send({ error: "Vehicle has no device assigned" });

      return getDeviceEvents({ windows, ...parsed.data });
    },
  );
}
