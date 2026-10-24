import type { FastifyInstance } from "fastify";
import { getCurrentUser } from "../../services/auth.service.js";
import { listDriverVehiclesFor } from "../../services/driverVehicles.service.js";
import { getProductsForUser } from "../../services/product.service.js";
import { requireAuth, requireModule } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export async function driverVehiclesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  // Only a signed-in person is asked of the Driver as themselves; an API key has no Driver account.
  app.addHook("preHandler", async (request, reply) => {
    if (request.apiKeyId) await reply.code(403).send({ error: "Forbidden" });
  });

  app.get(
    "/driver-vehicles",
    {
      preHandler: requireModule("mapa"),
      schema: {
        tags: ["Vehicles"],
        summary: "Vehículos de Gamonal que el admin de Gamonal Driver deja ver en el mapa (solo clientes con acceso a Driver)",
        security: AUTH,
      },
    },
    async (request) => {
      // The organization's own people already see the whole fleet in OneTrack: this is for a client with a flota.
      if (!request.user.allowedArea) return { vehicles: [] };
      const products = await getProductsForUser(request.user.orgId, request.user.userId, request.user.role);
      if (!products.some((p) => p.key === "driver")) return { vehicles: [] };
      const me = await getCurrentUser(request.user.userId);
      if (!me) return { vehicles: [] };
      return { vehicles: await listDriverVehiclesFor(me.email) };
    },
  );
}
