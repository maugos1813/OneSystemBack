import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { claimDevice, listDevicesForOrg } from "../../services/device.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const claimSchema = z.object({ imei: z.string().min(10).max(20) });

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/devices",
    {
      schema: {
        tags: ["Devices"],
        summary: "Listar los dispositivos de tu organización",
        security: AUTH,
      },
    },
    async (request) => {
      return listDevicesForOrg(request.user.orgId);
    },
  );

  app.post(
    "/devices/claim",
    {
      schema: {
        tags: ["Devices"],
        summary: "Vincular un dispositivo sin reclamar (por IMEI) a tu organización",
        security: AUTH,
        body: zodToJsonSchema(claimSchema),
      },
    },
    async (request, reply) => {
      const parsed = claimSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const device = await claimDevice(request.user.orgId, parsed.data.imei);
      if (!device) {
        return reply.code(404).send({ error: "Device not found or already claimed" });
      }
      return device;
    },
  );
}
