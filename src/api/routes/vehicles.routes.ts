import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createVehicle,
  deleteVehicle,
  getVehicleForOrg,
  listVehiclesForOrg,
  updateVehicle,
} from "../../services/vehicle.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  plate: z.string().max(20).optional(),
  deviceId: z.string().uuid().optional(),
  // Client-contract tag (e.g. "DHL", "UNIVEX") — freely assignable by the org, used to
  // filter the map view. Radius Velocity seeds it on first sync but never overwrites it
  // again, so a manual change here always sticks.
  fleetGroup: z.string().max(50).nullable().optional(),
});

const updateSchema = createSchema.partial();

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
// Mutating a vehicle (including reassigning its área) is left to owner/admin only — a
// manager/viewer restricted to one área could otherwise edit a vehicle's fleetGroup to
// pull it into their own área, or edit one outside their área if they guessed its id.
const MANAGE_VEHICLES = requireRole("owner", "admin");

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
      preHandler: MANAGE_VEHICLES,
      schema: {
        tags: ["Vehicles"],
        summary: "Crear un vehículo (owner/admin)",
        security: AUTH,
        body: zodToJsonSchema(createSchema),
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const vehicle = await createVehicle({ ...parsed.data, orgId: request.user.orgId });
      return reply.code(201).send(vehicle);
    },
  );

  app.patch(
    "/vehicles/:id",
    {
      preHandler: MANAGE_VEHICLES,
      schema: {
        tags: ["Vehicles"],
        summary: "Editar un vehículo (nombre, patente, dispositivo asignado, área) (owner/admin)",
        security: AUTH,
        body: zodToJsonSchema(updateSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const vehicle = await updateVehicle(request.user.orgId, id, parsed.data);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      return vehicle;
    },
  );

  app.delete(
    "/vehicles/:id",
    {
      preHandler: MANAGE_VEHICLES,
      schema: { tags: ["Vehicles"], summary: "Eliminar un vehículo (owner/admin)", security: AUTH },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteVehicle(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "Vehicle not found" });
      return reply.code(204).send();
    },
  );
}
