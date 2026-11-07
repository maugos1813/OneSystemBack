import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FleetVehiclesError, listFleetPictures, setFleetVehicles } from "../../services/fleet.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

const vehiclesBody = z.object({
  fleet: z.string().trim().min(1).max(50),
  vehicleIds: z.array(z.string().uuid()).max(1000),
});

/** Owner/admin, and not limited to one fleet: the people who decide which vehicles each fleet has. */
async function requireOrgWideAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.allowedArea) await reply.code(403).send({ error: "Fleets are managed by organization-wide accounts" });
}

export async function fleetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // What the map needs to draw each plate's tag: every user of the organization, within their own fleet. A fleet is a team account
  // limited to it, so its picture is set where the team is managed (the account's photo), not here.
  app.get(
    "/fleets",
    { schema: { tags: ["Fleets"], summary: "Las flotas y su imagen (para las placas del mapa)", security: AUTH } },
    async (request) => listFleetPictures(request.user.orgId, request.user.allowedArea),
  );

  // Which vehicles a fleet has, chosen by hand: exactly this list (the others it had are left without a fleet).
  app.put(
    "/fleets/vehicles",
    {
      preHandler: [requireRole("owner", "admin"), requireOrgWideAdmin],
      schema: { tags: ["Fleets"], summary: "Elegir los vehículos de una flota (owner/admin)", security: AUTH },
    },
    async (request, reply) => {
      const parsed = vehiclesBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        return await setFleetVehicles(request.user.orgId, parsed.data.fleet, parsed.data.vehicleIds);
      } catch (err) {
        if (err instanceof FleetVehiclesError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );
}
