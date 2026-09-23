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
import { requireAuth } from "../middlewares/auth.middleware.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  plate: z.string().max(20).optional(),
  deviceId: z.string().uuid().optional(),
});

const updateSchema = createSchema.partial();

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export async function vehiclesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/vehicles",
    { schema: { tags: ["Vehicles"], summary: "Listar vehículos", security: AUTH } },
    async (request) => {
      return listVehiclesForOrg(request.user.orgId);
    },
  );

  app.get(
    "/vehicles/:id",
    { schema: { tags: ["Vehicles"], summary: "Obtener un vehículo", security: AUTH } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const vehicle = await getVehicleForOrg(request.user.orgId, id);
      if (!vehicle) return reply.code(404).send({ error: "Vehicle not found" });
      return vehicle;
    },
  );

  app.post(
    "/vehicles",
    {
      schema: {
        tags: ["Vehicles"],
        summary: "Crear un vehículo",
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
      schema: {
        tags: ["Vehicles"],
        summary: "Editar un vehículo (nombre, patente, dispositivo asignado)",
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
    { schema: { tags: ["Vehicles"], summary: "Eliminar un vehículo", security: AUTH } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteVehicle(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "Vehicle not found" });
      return reply.code(204).send();
    },
  );
}
