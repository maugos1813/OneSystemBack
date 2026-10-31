import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createVehicle,
  deleteVehicle,
  getVehicleForOrg,
  listVehiclesForOrg,
  updateVehicle,
} from "../../services/vehicle.service.js";
import { getUserModules } from "../../services/userModules.service.js";
import { getVehicleProfile, listVehicleOdometers, ProfileError, setVehicleOdometer } from "../../services/vehicleProfile.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const profileText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

/** Fuel types of a vehicle's profile (the screen names them). */
export const FUEL_TYPES = ["diesel", "petrol", "lpg", "cng", "electric", "hybrid", "other"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  plate: z.string().max(20).optional(),
  deviceId: z.string().uuid().optional(),
  // Client-contract tag (e.g. "DHL", "UNIVEX") — freely assignable by the org, used to
  // filter the map view. Radius Velocity seeds it on first sync but never overwrites it
  // again, so a manual change here always sticks.
  fleetGroup: z.string().max(50).nullable().optional(),
  // Profile: what the vehicle is.
  brand: profileText(50),
  model: profileText(50),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  vin: profileText(30),
  fuelType: z.enum(FUEL_TYPES).nullable().optional(),
  color: profileText(30),
  notes: profileText(2000),
});

const odometerSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  km: z.number().int().min(0).max(5_000_000).optional(),
});
const idParams = z.object({ id: z.string().uuid() });

const updateSchema = createSchema.partial();

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
/**
 * Who may create, edit or delete vehicles. Owner and admin always can. A client (viewer/manager) can too, but only if
 * the admin gave them the "vehiculos" section AND a flota: they then manage the vehicles of that flota and nothing else.
 * The handlers below pin them to it — they cannot pick another flota or assign a device (that is the admin's job), so a
 * client can never pull a vehicle from someone else's flota into theirs.
 */
async function requireVehicleWrite(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { role, allowedArea, userId } = request.user;
  if (role === "owner" || role === "admin") return;
  if (allowedArea && (await getUserModules(userId)).includes("vehiculos")) return;
  await reply.code(403).send({ error: "Forbidden" });
}

/** Setting the km: those who manage maintenance (manager too) and those who may edit the vehicle. */
async function requireOdometerWrite(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.role === "manager") return;
  return requireVehicleWrite(request, reply);
}

const isClient = (request: FastifyRequest) => request.user.role !== "owner" && request.user.role !== "admin";
const ADMIN_ONLY = "Solo tu administrador puede asignar el dispositivo o cambiar la flota";

export async function vehiclesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/vehicles",
    { schema: { tags: ["Vehicles"], summary: "Listar vehículos", security: AUTH } },
    async (request) => {
      return listVehiclesForOrg(request.user.orgId, request.user.allowedArea);
    },
  );

  app.get(
    "/vehicles/odometers",
    { schema: { tags: ["Vehicles"], summary: "Km actual de cada vehículo visible", security: AUTH } },
    async (request) => listVehicleOdometers(request.user.orgId, request.user.allowedArea),
  );

  app.get(
    "/vehicles/:id/profile",
    { schema: { tags: ["Vehicles"], summary: "Perfil del vehículo: sus datos y su kilometraje", security: AUTH } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid vehicle id" });
      try {
        return await getVehicleProfile(request.user.orgId, request.user.allowedArea, params.data.id);
      } catch (err) {
        if (err instanceof ProfileError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.put(
    "/vehicles/:id/odometer",
    {
      preHandler: requireOdometerWrite,
      schema: { tags: ["Vehicles"], summary: "Fijar el km actual y si se lleva a mano o solo (automático)", security: AUTH },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = odometerSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: body.success ? "Invalid vehicle id" : body.error.flatten() });
      }
      try {
        return await setVehicleOdometer(request.user.orgId, request.user.allowedArea, params.data.id, body.data);
      } catch (err) {
        if (err instanceof ProfileError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get(
    "/vehicles/:id",
    { schema: { tags: ["Vehicles"], summary: "Obtener un vehículo", security: AUTH } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const vehicle = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      return vehicle;
    },
  );

  app.post(
    "/vehicles",
    {
      preHandler: requireVehicleWrite,
      schema: {
        tags: ["Vehicles"],
        summary: "Crear un vehículo (owner/admin, o un cliente en su propia flota)",
        security: AUTH,
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      if (isClient(request)) {
        if (parsed.data.deviceId || (parsed.data.fleetGroup && parsed.data.fleetGroup !== request.user.allowedArea)) {
          return reply.code(403).send({ error: ADMIN_ONLY });
        }
        parsed.data.fleetGroup = request.user.allowedArea;
      }

      const vehicle = await createVehicle({ ...parsed.data, orgId: request.user.orgId });
      return reply.code(201).send(vehicle);
    },
  );

  app.patch(
    "/vehicles/:id",
    {
      preHandler: requireVehicleWrite,
      schema: {
        tags: ["Vehicles"],
        summary: "Editar un vehículo (owner/admin; un cliente solo el nombre, la patente y el perfil de los suyos)",
        security: AUTH,
        body: zodToJsonSchema(updateSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      if (isClient(request)) {
        if (parsed.data.deviceId !== undefined || parsed.data.fleetGroup !== undefined) {
          return reply.code(403).send({ error: ADMIN_ONLY });
        }
        // A vehicle outside their flota does not exist for them.
        if (!(await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea))) {
          return reply.code(404).send({ error: "Vehicle not found" });
        }
      }

      const vehicle = await updateVehicle(request.user.orgId, id, parsed.data);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      return vehicle;
    },
  );

  app.delete(
    "/vehicles/:id",
    {
      preHandler: requireVehicleWrite,
      schema: { tags: ["Vehicles"], summary: "Eliminar un vehículo (owner/admin, o un cliente de su propia flota; con dispositivo asignado pide ?confirmDevice=true)", security: AUTH },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (isClient(request)) {
        const own = await getVehicleForOrg(request.user.orgId, id, request.user.allowedArea);
        if (!own) return reply.code(404).send({ error: "Vehicle not found" });
        // Deleting a vehicle that has a device unlinks the device and takes it off the map; only the admin can link it
        // again. So a client has to say, explicitly, that they know.
        const confirmed = (request.query as { confirmDevice?: string }).confirmDevice === "true";
        if (own.deviceId && !confirmed) {
          return reply.code(409).send({
            error: "Este vehículo tiene un dispositivo asignado. Confirma que quieres eliminarlo.",
            code: "DEVICE_ASSIGNED",
          });
        }
      }
      const deleted = await deleteVehicle(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "Vehicle not found" });
      return reply.code(204).send();
    },
  );
}
