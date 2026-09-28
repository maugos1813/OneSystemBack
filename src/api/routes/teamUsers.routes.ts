import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createTeamMember,
  listTeamMembers,
  updateTeamMemberProducts,
  updateTeamMemberRole,
} from "../../services/teamUser.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const MANAGE_ROLES = requireRole("owner", "admin");

const createMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  role: z.enum(["admin", "viewer"]),
  productKeys: z.array(z.string()).optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "viewer"]),
});

const updateProductsSchema = z.object({
  productKeys: z.array(z.string()),
});

/** Postgres unique_violation error code; pg's driver attaches it as `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export async function teamUsersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/users",
    { schema: { tags: ["Team"], summary: "Listar los miembros de la organización", security: AUTH } },
    async (request) => {
      return listTeamMembers(request.user.orgId);
    },
  );

  app.post(
    "/users",
    {
      preHandler: MANAGE_ROLES,
      schema: {
        tags: ["Team"],
        summary: "Invitar un miembro nuevo a la organización (admin/owner)",
        security: AUTH,
        body: zodToJsonSchema(createMemberSchema),
      },
    },
    async (request, reply) => {
      const parsed = createMemberSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        const member = await createTeamMember({ orgId: request.user.orgId, ...parsed.data });
        return reply.code(201).send(member);
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: "Email already registered" });
        throw err;
      }
    },
  );

  app.patch(
    "/users/:id/role",
    {
      preHandler: MANAGE_ROLES,
      schema: {
        tags: ["Team"],
        summary: "Cambiar el rol de un miembro (Admin/Usuario)",
        security: AUTH,
        body: zodToJsonSchema(updateRoleSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === request.user.userId) {
        return reply.code(400).send({ error: "Can't change your own role" });
      }

      const parsed = updateRoleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await updateTeamMemberRole(request.user.orgId, id, parsed.data.role);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, email: updated.email, role: updated.role };
    },
  );

  app.patch(
    "/users/:id/products",
    {
      preHandler: MANAGE_ROLES,
      schema: {
        tags: ["Team"],
        summary: "Elegir a qué cards tiene acceso un miembro (solo aplica a rol Usuario)",
        security: AUTH,
        body: zodToJsonSchema(updateProductsSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateProductsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const ok = await updateTeamMemberProducts(request.user.orgId, id, parsed.data.productKeys);
      if (!ok) return reply.code(404).send({ error: "User not found" });
      return reply.code(204).send();
    },
  );
}
