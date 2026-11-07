import type { FastifyInstance } from "fastify";
import { listFleetPictures } from "../../services/fleet.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export async function fleetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // What the map needs to draw each plate's tag: every user of the organization, within their own fleet. A fleet is a team account
  // limited to it, so its picture is set where the team is managed (the account's photo), not here.
  app.get(
    "/fleets",
    { schema: { tags: ["Fleets"], summary: "Las flotas y su imagen (para las placas del mapa)", security: AUTH } },
    async (request) => listFleetPictures(request.user.orgId, request.user.allowedArea),
  );
}
