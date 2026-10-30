import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getLatestPosition } from "../../services/position.service.js";
import { EtaError, estimateRoute, MAX_QUERY_LENGTH } from "../../services/eta.service.js";
import { getVehicleForOrg } from "../../services/vehicle.service.js";
import { requireAuth, requireModule } from "../middlewares/auth.middleware.js";
import { FixedWindowLimiter } from "../middlewares/rateLimit.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const idParams = z.object({ id: z.string().uuid() });
const query = z.object({ to: z.string().max(MAX_QUERY_LENGTH) });
/** The free map services behind this are shared: a person asking again and again is held back. */
const LIMIT_PER_MINUTE = 12;
let limiter = new FixedWindowLimiter(LIMIT_PER_MINUTE, 60_000);

/** For tests: forget every count. */
export function resetEtaLimit(): void {
  limiter = new FixedWindowLimiter(LIMIT_PER_MINUTE, 60_000);
}

export async function etaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/vehicles/:id/eta",
    {
      preHandler: requireModule("mapa"),
      schema: {
        tags: ["Vehicles"],
        summary:
          "Cuánto tarda el vehículo en llegar a una ciudad o dirección (estimación por carretera, con un margen de tráfico)",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        querystring: zodToJsonSchema(query),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const q = query.safeParse(request.query);
      if (!params.success || !q.success) return reply.code(400).send({ error: "Invalid request" });

      const gate = limiter.hit(request.user.userId);
      if (!gate.allowed) {
        void reply.header("Retry-After", gate.retryAfterSec);
        return reply
          .code(429)
          .send({
            error: "Demasiadas consultas seguidas. Espera un momento.",
            retryAfterSeconds: gate.retryAfterSec,
          });
      }

      const vehicle = await getVehicleForOrg(request.user.orgId, params.data.id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      const position = vehicle.deviceId ? await getLatestPosition(vehicle.deviceId) : undefined;
      if (!position) return reply.code(404).send({ error: "Este vehículo todavía no tiene una posición." });

      try {
        const estimate = await estimateRoute({ lat: position.lat, lng: position.lng }, q.data.to);
        const now = Date.now();
        return {
          vehicleId: vehicle.id,
          ...estimate,
          from: { lat: position.lat, lng: position.lng, at: position.ts.toISOString() },
          /** How old the position the estimate starts from is: a vehicle that stopped reporting has moved since. */
          positionAgeMin: Math.max(0, Math.round((now - position.ts.getTime()) / 60_000)),
          arrivalAt: new Date(now + estimate.durationMin * 60_000).toISOString(),
        };
      } catch (err) {
        if (err instanceof EtaError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );
}
