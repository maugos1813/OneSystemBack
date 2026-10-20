import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { claimDevice, getDeviceDetail, isValidImei, listDevicesForOrg, updateDevice } from "../../services/device.service.js";
import {
  CommandError,
  listDeviceCommands,
  requestImmobilizer,
} from "../../services/deviceCommand.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const model = z.string().trim().min(1).max(50);

const claimSchema = z.object({ imei: z.string().min(10).max(20), model: model.optional() });

/** "" clears the field. */
const optionalLabel = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const patchSchema = z.object({
  model: model.optional(),
  serialNumber: optionalLabel(32),
  firmware: optionalLabel(32),
});

const immobilizerSchema = z.object({ action: z.enum(["lock", "unlock"]) });

const idParams = z.object({ id: z.string().uuid() });

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

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
      return listDevicesForOrg(request.user.orgId, request.user.allowedArea);
    },
  );

  app.post(
    "/devices/claim",
    {
      preHandler: requireRole("owner", "admin"),
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

      const { imei, model } = parsed.data;
      if (/^\d{15}$/.test(imei) && !isValidImei(imei)) {
        return reply.code(400).send({ error: "IMEI inválido: revisa los 15 dígitos" });
      }

      const device = await claimDevice(request.user.orgId, imei, model);
      if (!device) {
        return reply.code(404).send({ error: "Device not found or already claimed" });
      }
      return device;
    },
  );

  app.get(
    "/devices/:id",
    {
      schema: {
        tags: ["Devices"],
        summary: "Ficha de un dispositivo: datos, vehículo, SIM y lo que está enviando",
        security: AUTH,
        params: zodToJsonSchema(idParams),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid device id" });

      const { orgId, role, allowedArea } = request.user;
      const detail = await getDeviceDetail(orgId, params.data.id, {
        allowedArea,
        includeSim: (role === "owner" || role === "admin") && !allowedArea,
      });
      if (!detail) return reply.code(404).send({ error: "Device not found" });
      return detail;
    },
  );

  app.patch(
    "/devices/:id",
    {
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["Devices"],
        summary: "Editar el modelo, número de serie y firmware de un dispositivo",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        body: zodToJsonSchema(patchSchema),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = patchSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid device id" : body.error.flatten() });
      }
      // The sheet of a device outside the account's área isn't reachable, so neither is its edit.
      if (request.user.allowedArea) return reply.code(403).send({ error: "Forbidden" });

      const patch = Object.fromEntries(Object.entries(body.data).filter(([, value]) => value !== undefined));
      const updated = await updateDevice(request.user.orgId, params.data.id, patch);
      if (!updated) return reply.code(404).send({ error: "Device not found" });
      return updated;
    },
  );

  app.post(
    "/devices/:id/immobilizer",
    {
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["Devices"],
        summary: "Bloquear o desbloquear el vehículo (salida del equipo)",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        body: zodToJsonSchema(immobilizerSchema),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = immobilizerSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid device id" : body.error.flatten() });
      }
      // An account limited to one área does not get to cut vehicles.
      if (request.user.allowedArea) return reply.code(403).send({ error: "Forbidden" });

      try {
        const command = await requestImmobilizer(request.user.orgId, request.user.userId, params.data.id, body.data.action);
        return reply.code(202).send(command);
      } catch (err) {
        if (err instanceof CommandError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get(
    "/devices/:id/commands",
    {
      preHandler: requireRole("owner", "admin"),
      schema: {
        tags: ["Devices"],
        summary: "Últimas órdenes enviadas al dispositivo (bloqueos y desbloqueos)",
        security: AUTH,
        params: zodToJsonSchema(idParams),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid device id" });
      if (request.user.allowedArea) return reply.code(403).send({ error: "Forbidden" });
      return listDeviceCommands(request.user.orgId, params.data.id);
    },
  );
}
