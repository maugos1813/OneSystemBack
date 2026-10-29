import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  calibrateOdometer,
  createPlan,
  deletePlan,
  listMaintenance,
  listRecords,
  MaintenanceError,
  registerService,
  updatePlan,
} from "../../services/maintenance.service.js";
import { requireAuth, requireModule, requireRole } from "../middlewares/auth.middleware.js";

/**
 * Service plans of the fleet (oil, tyres, inspection…): everyone who can see a vehicle sees its
 * plans; owner, admin and manager manage them. An área-limited account only reaches the vehicles
 * of its área, for reads and writes alike. API keys never get here (they are /v1 read-only).
 */

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const MANAGE = requireRole("owner", "admin", "manager");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const interval = (max: number) => z.number().int().min(1).max(max).nullable().optional();
const km = z.number().int().min(0).max(5_000_000);
const dateField = z.coerce.date();

const planFields = {
  name: z.string().trim().min(1).max(100),
  intervalKm: interval(500_000),
  intervalMonths: interval(240),
  lastDoneAt: dateField.nullable().optional(),
  lastDoneKm: km.nullable().optional(),
  /** What the dashboard reads now: lines the GPS count up with it. */
  dashboardKm: km.nullable().optional(),
  notes: optionalText(1000),
};

const createSchema = z.object({ vehicleId: z.string().uuid(), ...planFields });
const patchSchema = z.object(planFields).partial();
const recordSchema = z.object({
  doneAt: dateField.optional(),
  odometerKm: km.nullable().optional(),
  dashboardKm: km.nullable().optional(),
  notes: optionalText(1000),
});
const calibrateSchema = z.object({ dashboardKm: km });
const idParams = z.object({ id: z.string().uuid() });

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof MaintenanceError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/** Drops keys the caller did not send, so an edit only touches what it names. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  app.addHook("preHandler", requireModule("mantenimiento"));

  app.get(
    "/maintenance",
    { schema: { tags: ["Maintenance"], summary: "Planes de mantenimiento por vehículo, con su estado", security: AUTH } },
    async (request) => listMaintenance(request.user.orgId, request.user.allowedArea),
  );

  app.post(
    "/maintenance/plans",
    { preHandler: MANAGE, schema: { tags: ["Maintenance"], summary: "Crear un plan de mantenimiento", security: AUTH } },
    async (request, reply) => {
      const body = createSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const { vehicleId, ...input } = body.data;
      try {
        return reply.code(201).send(await createPlan(request.user.orgId, request.user.allowedArea, vehicleId, defined(input) as typeof input));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.patch(
    "/maintenance/plans/:id",
    { preHandler: MANAGE, schema: { tags: ["Maintenance"], summary: "Editar un plan", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = patchSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid plan id" : body.error.flatten() });
      }
      try {
        return await updatePlan(request.user.orgId, request.user.allowedArea, params.data.id, defined(body.data));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete(
    "/maintenance/plans/:id",
    { preHandler: MANAGE, schema: { tags: ["Maintenance"], summary: "Eliminar un plan y su historial", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid plan id" });
      try {
        await deletePlan(request.user.orgId, request.user.allowedArea, params.data.id);
        return reply.code(204).send();
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get(
    "/maintenance/plans/:id/records",
    { schema: { tags: ["Maintenance"], summary: "Historial de servicios de un plan", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid plan id" });
      try {
        return await listRecords(request.user.orgId, request.user.allowedArea, params.data.id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    "/maintenance/plans/:id/records",
    { preHandler: MANAGE, schema: { tags: ["Maintenance"], summary: "Registrar que se hizo el servicio", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = recordSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid plan id" : body.error.flatten() });
      }
      try {
        return reply.code(201).send(await registerService(request.user.orgId, request.user.allowedArea, params.data.id, defined(body.data)));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.put(
    "/maintenance/vehicles/:id/odometer",
    { preHandler: MANAGE, schema: { tags: ["Maintenance"], summary: "Calibrar el odómetro con el kilometraje del tablero", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = calibrateSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid vehicle id" : body.error.flatten() });
      }
      try {
        return await calibrateOdometer(request.user.orgId, request.user.allowedArea, params.data.id, body.data.dashboardKm);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
