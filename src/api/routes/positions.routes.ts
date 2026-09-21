import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getLatestPosition, getPositionHistory } from "../../services/position.service.js";
import { getVehicleForOrg } from "../../services/vehicle.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const historyQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

export async function positionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get("/vehicles/:id/positions/latest", async (request, reply) => {
    const { id } = request.params as { id: string };
    const vehicle = await getVehicleForOrg(request.user.orgId, id);
    if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
    if (!vehicle.deviceId) return reply.code(404).send({ error: "Vehicle has no device assigned" });

    const position = await getLatestPosition(vehicle.deviceId);
    if (!position) return reply.code(404).send({ error: "No positions recorded yet" });
    return position;
  });

  app.get("/vehicles/:id/positions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const vehicle = await getVehicleForOrg(request.user.orgId, id);
    if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
    if (!vehicle.deviceId) return reply.code(404).send({ error: "Vehicle has no device assigned" });

    return getPositionHistory({ deviceId: vehicle.deviceId, ...parsed.data });
  });
}
