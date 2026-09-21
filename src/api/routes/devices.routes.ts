import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { claimDevice, listDevicesForOrg } from "../../services/device.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const claimSchema = z.object({ imei: z.string().min(10).max(20) });

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get("/devices", async (request) => {
    return listDevicesForOrg(request.user.orgId);
  });

  app.post("/devices/claim", async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const device = await claimDevice(request.user.orgId, parsed.data.imei);
    if (!device) {
      return reply.code(404).send({ error: "Device not found or already claimed" });
    }
    return device;
  });
}
