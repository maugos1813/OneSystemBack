import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { getSettings, updateSettings } from "../../services/settings.service.js";

const workingHoursDaySchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const workingHoursSchema = z
  .object({
    monday: workingHoursDaySchema,
    tuesday: workingHoursDaySchema,
    wednesday: workingHoursDaySchema,
    thursday: workingHoursDaySchema,
    friday: workingHoursDaySchema,
    saturday: workingHoursDaySchema,
    sunday: workingHoursDaySchema,
  })
  .partial();

const alertsSchema = z
  .object({
    afterHoursEnabled: z.boolean(),
    deviceOfflineEnabled: z.boolean(),
    deviceOfflineHours: z.number().min(0.5).max(72),
    lowBatteryEnabled: z.boolean(),
    lowBatteryVoltage: z.number().min(6).max(30),
    speedingEnabled: z.boolean(),
    speedLimitKmh: z.number().min(10).max(300),
    excessiveIdlingEnabled: z.boolean(),
    excessiveIdlingMinutes: z.number().min(1).max(240),
    geofenceEnabled: z.boolean(),
  })
  .partial();

const updateSchema = z.object({
  orgName: z.string().min(2).max(200).optional(),
  workingHours: workingHoursSchema.optional(),
  alerts: alertsSchema.optional(),
});

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/settings",
    {
      schema: {
        tags: ["Settings"],
        summary: "Nombre de la organización, horario laboral y preferencias de alertas",
        security: AUTH,
      },
    },
    async (request, reply) => {
      const settings = await getSettings(request.user.orgId);
      if (!settings) return reply.code(404).send({ error: "Organization not found" });
      return settings;
    },
  );

  app.patch(
    "/settings",
    {
      schema: {
        tags: ["Settings"],
        summary: "Editar nombre, horario laboral y/o preferencias de alertas (parcial)",
        security: AUTH,
        body: zodToJsonSchema(updateSchema),
      },
    },
    async (request, reply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const settings = await updateSettings(request.user.orgId, parsed.data);
      if (!settings) return reply.code(404).send({ error: "Organization not found" });
      return settings;
    },
  );
}
