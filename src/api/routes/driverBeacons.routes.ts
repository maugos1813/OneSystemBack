import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createBeacon,
  deleteBeacon,
  DriverBeaconError,
  getVehicleDriver,
  listBeaconsByVehicle,
  listDetectedBeacons,
  listRegisteredBeacons,
  renameBeacon,
} from "../../services/driverBeacon.service.js";
import { requireAuth, requireModule, requireRole } from "../middlewares/auth.middleware.js";

/**
 * Drivers' Bluetooth beacons. Registering them is for owner/admin of an organization-wide account; seeing who drove a
 * vehicle needs the Conducción section (it is about people) and only reaches the vehicles of the caller's área.
 */

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const DEFAULT_DRIVER_WINDOW_HOURS = 6;
const MAX_DRIVER_WINDOW_HOURS = 24 * 31;

const createSchema = z
  .object({
    beaconId: z.string().trim().min(1).max(100).optional(),
    /** The MAC printed on an EYE Beacon's label, with or without separators. */
    mac: z.string().trim().min(12).max(17).optional(),
    driverName: z.string().trim().min(1).max(100),
  })
  .refine((v) => (v.beaconId === undefined) !== (v.mac === undefined), "Indica la MAC o el identificador de la baliza, no ambos");
const renameSchema = z.object({ driverName: z.string().trim().min(1).max(100) });
const idParams = z.object({ id: z.string().uuid() });
const detectedQuery = z.object({ hours: z.coerce.number().int().min(1).max(72).default(24) });
const byVehicleQuery = z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) });
const driverQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

async function requireOrgWideAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.allowedArea) await reply.code(403).send({ error: "Beacons are managed by organization-wide accounts" });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DriverBeaconError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export async function driverBeaconsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  const admin = [requireRole("owner", "admin"), requireOrgWideAdmin];

  app.get(
    "/driver-beacons",
    { preHandler: admin, schema: { tags: ["Choferes"], summary: "Balizas de choferes registradas (owner/admin)", security: AUTH } },
    async (request) => listRegisteredBeacons(request.user.orgId),
  );

  app.get(
    "/driver-beacons/detected",
    {
      preHandler: admin,
      schema: {
        tags: ["Choferes"],
        summary: "Balizas que oyeron los GPS en las últimas horas, con su chofer si ya está asignada (owner/admin)",
        security: AUTH,
        querystring: zodToJsonSchema(detectedQuery),
      },
    },
    async (request, reply) => {
      const query = detectedQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      return listDetectedBeacons(request.user.orgId, query.data.hours);
    },
  );

  app.get(
    "/driver-beacons/by-vehicle",
    {
      preHandler: admin,
      schema: {
        tags: ["Choferes"],
        summary: "Por vehículo con GPS Teltonika: las balizas que oyó, con el chofer de cada una (owner/admin)",
        security: AUTH,
        querystring: zodToJsonSchema(byVehicleQuery),
      },
    },
    async (request, reply) => {
      const query = byVehicleQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      return listBeaconsByVehicle(request.user.orgId, query.data.hours);
    },
  );

  app.post(
    "/driver-beacons",
    {
      preHandler: admin,
      schema: { tags: ["Choferes"], summary: "Asignar una baliza a un chofer (owner/admin)", security: AUTH, body: zodToJsonSchema(createSchema) },
    },
    async (request, reply) => {
      const body = createSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        return reply.code(201).send(await createBeacon(request.user.orgId, body.data));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    "/driver-beacons/:id",
    {
      preHandler: admin,
      schema: { tags: ["Choferes"], summary: "Cambiar el chofer de una baliza (owner/admin)", security: AUTH, params: zodToJsonSchema(idParams), body: zodToJsonSchema(renameSchema) },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = renameSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
      try {
        return await renameBeacon(request.user.orgId, params.data.id, body.data.driverName);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/driver-beacons/:id",
    { preHandler: admin, schema: { tags: ["Choferes"], summary: "Quitar una baliza (owner/admin)", security: AUTH, params: zodToJsonSchema(idParams) } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid id" });
      try {
        await deleteBeacon(request.user.orgId, params.data.id);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/vehicles/:id/driver",
    {
      preHandler: requireModule("conduccion"),
      schema: {
        tags: ["Choferes"],
        summary: "Quién condujo el vehículo en el periodo (por las balizas que oyó el GPS mientras se movía)",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        querystring: zodToJsonSchema(driverQuery),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const query = driverQuery.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid request" });
      const to = query.data.to ?? new Date();
      const from = query.data.from ?? new Date(to.getTime() - DEFAULT_DRIVER_WINDOW_HOURS * 3_600_000);
      if (from >= to || to.getTime() - from.getTime() > MAX_DRIVER_WINDOW_HOURS * 3_600_000) {
        return reply.code(400).send({ error: "Invalid period" });
      }
      try {
        return await getVehicleDriver(request.user.orgId, request.user.allowedArea, params.data.id, from, to);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
