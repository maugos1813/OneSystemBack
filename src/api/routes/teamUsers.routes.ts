import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { User } from "../../db/schema/index.js";
import {
  createTeamMember,
  deleteTeamMember,
  getTeamMember,
  getUserProductKeys,
  listTeamMembers,
  updateTeamMemberArea,
  updateTeamMemberEmail,
  updateTeamMemberName,
  updateTeamMemberPassword,
  updateTeamMemberProducts,
  updateTeamMemberRole,
} from "../../services/teamUser.service.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const MANAGE_ROLES = requireRole("owner", "admin");
// "manager" may also create/edit/delete team members, but only its own sub-users — the
// handlers below re-check that with canManageOther() on top of this coarse role gate.
const MANAGE_MEMBERS = requireRole("owner", "admin", "manager");

const createMemberSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  role: z.enum(["admin", "manager", "viewer"]),
  allowedArea: z.string().max(50).nullable().optional(),
  productKeys: z.array(z.string()).optional(),
});

const updateNameSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "manager", "viewer"]),
});

const updateProductsSchema = z.object({
  productKeys: z.array(z.string()),
});

const updateAreaSchema = z.object({
  allowedArea: z.string().max(50).nullable(),
});

const updateEmailSchema = z.object({
  email: z.string().email(),
});

const updatePasswordSchema = z.object({
  password: z.string().min(8).max(100),
});

/** Postgres unique_violation error code; pg's driver attaches it as `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

/** Whether `requester` may edit/delete `target`'s products, área, or existence —
 * deliberately excludes self-service (a restricted user editing their own products/área
 * would be a privilege-escalation bug, not a convenience). owner/admin may act on
 * anyone but the owner; a manager only on the sub-users it created itself. */
function canManageOther(
  requester: { userId: string; role: User["role"] },
  target: Pick<User, "id" | "role" | "parentUserId">,
): boolean {
  if (requester.role === "owner" || requester.role === "admin") return target.role !== "owner";
  if (requester.role === "manager") return target.parentUserId === requester.userId;
  return false;
}

export async function teamUsersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/users",
    { schema: { tags: ["Team"], summary: "Listar los miembros visibles para vos", security: AUTH } },
    async (request) => {
      return listTeamMembers(request.user.orgId, request.user.userId, request.user.role);
    },
  );

  app.post(
    "/users",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Invitar un miembro nuevo (owner/admin) o un sub-usuario propio (manager)",
        security: AUTH,
        body: zodToJsonSchema(createMemberSchema),
      },
    },
    async (request, reply) => {
      const parsed = createMemberSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const data = parsed.data;

      try {
        if (request.user.role === "manager") {
          // A manager can only mint viewers under itself, never broader than its own
          // área or product access — otherwise it could hand a sub-user more than it
          // has itself.
          if (data.role !== "viewer") {
            return reply.code(403).send({ error: "Managers can only create viewer sub-users" });
          }
          if (request.user.allowedArea && data.allowedArea && data.allowedArea !== request.user.allowedArea) {
            return reply.code(400).send({ error: "Can't grant an área you don't have yourself" });
          }
          const allowedArea = request.user.allowedArea ? request.user.allowedArea : (data.allowedArea ?? null);

          const ownKeys = await getUserProductKeys(request.user.userId);
          const requestedKeys = data.productKeys ?? ownKeys;
          if (!requestedKeys.every((k) => ownKeys.includes(k))) {
            return reply.code(400).send({ error: "Can't grant a product you don't have yourself" });
          }

          const member = await createTeamMember({
            orgId: request.user.orgId,
            name: data.name,
            email: data.email,
            password: data.password,
            role: "viewer",
            parentUserId: request.user.userId,
            allowedArea,
            productKeys: requestedKeys,
          });
          return reply.code(201).send(member);
        }

        const member = await createTeamMember({
          orgId: request.user.orgId,
          name: data.name,
          email: data.email,
          password: data.password,
          role: data.role,
          allowedArea: data.allowedArea ?? null,
          productKeys: data.productKeys,
        });
        return reply.code(201).send(member);
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: "Email already registered" });
        throw err;
      }
    },
  );

  app.patch(
    "/users/:id/name",
    {
      schema: {
        tags: ["Team"],
        summary: "Editar el nombre de un miembro (uno mismo, o owner/admin/manager sobre otros)",
        security: AUTH,
        body: zodToJsonSchema(updateNameSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const isSelf = id === request.user.userId;

      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!isSelf && !canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = updateNameSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await updateTeamMemberName(request.user.orgId, id, parsed.data.name);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, name: updated.name, email: updated.email, role: updated.role };
    },
  );

  app.patch(
    "/users/:id/role",
    {
      preHandler: MANAGE_ROLES,
      schema: {
        tags: ["Team"],
        summary: "Cambiar el rol de un miembro (Admin/Manager/Usuario)",
        security: AUTH,
        body: zodToJsonSchema(updateRoleSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === request.user.userId) {
        return reply.code(400).send({ error: "Can't change your own role" });
      }

      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (target.role === "owner") {
        return reply.code(400).send({ error: "Can't change the owner's role" });
      }

      const parsed = updateRoleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await updateTeamMemberRole(request.user.orgId, id, parsed.data.role);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, email: updated.email, role: updated.role };
    },
  );

  app.patch(
    "/users/:id/email",
    {
      schema: {
        tags: ["Team"],
        summary: "Editar el email de un miembro (uno mismo, o owner/admin/manager sobre otros)",
        security: AUTH,
        body: zodToJsonSchema(updateEmailSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const isSelf = id === request.user.userId;

      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!isSelf && !canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = updateEmailSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      try {
        const updated = await updateTeamMemberEmail(request.user.orgId, id, parsed.data.email);
        if (!updated) return reply.code(404).send({ error: "User not found" });
        return { id: updated.id, email: updated.email, role: updated.role };
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: "Email already registered" });
        throw err;
      }
    },
  );

  app.patch(
    "/users/:id/password",
    {
      schema: {
        tags: ["Team"],
        summary: "Cambiar la contraseña de un miembro (uno mismo, o owner/admin/manager sobre otros)",
        security: AUTH,
        body: zodToJsonSchema(updatePasswordSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const isSelf = id === request.user.userId;

      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!isSelf && !canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = updatePasswordSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const ok = await updateTeamMemberPassword(request.user.orgId, id, parsed.data.password);
      if (!ok) return reply.code(404).send({ error: "User not found" });
      return reply.code(204).send();
    },
  );

  app.patch(
    "/users/:id/area",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Restringir a un miembro a un área (DHL/UNIVEX) — owner/admin, o manager sobre sus propios sub-usuarios",
        security: AUTH,
        body: zodToJsonSchema(updateAreaSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = updateAreaSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      if (
        request.user.role === "manager" &&
        request.user.allowedArea &&
        parsed.data.allowedArea !== request.user.allowedArea
      ) {
        return reply.code(400).send({ error: "Can't grant an área you don't have yourself" });
      }

      const updated = await updateTeamMemberArea(request.user.orgId, id, parsed.data.allowedArea);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, allowedArea: updated.allowedArea };
    },
  );

  app.patch(
    "/users/:id/products",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Elegir a qué cards tiene acceso un miembro (owner/admin, o manager sobre sus propios sub-usuarios)",
        security: AUTH,
        body: zodToJsonSchema(updateProductsSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const parsed = updateProductsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      if (request.user.role === "manager") {
        const ownKeys = await getUserProductKeys(request.user.userId);
        if (!parsed.data.productKeys.every((k) => ownKeys.includes(k))) {
          return reply.code(400).send({ error: "Can't grant a product you don't have yourself" });
        }
      }

      const ok = await updateTeamMemberProducts(request.user.orgId, id, parsed.data.productKeys);
      if (!ok) return reply.code(404).send({ error: "User not found" });
      return reply.code(204).send();
    },
  );

  app.delete(
    "/users/:id",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Eliminar un miembro (owner/admin, o manager sobre sus propios sub-usuarios)",
        security: AUTH,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === request.user.userId) {
        return reply.code(400).send({ error: "Can't delete your own account" });
      }

      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const deleted = await deleteTeamMember(request.user.orgId, id);
      if (!deleted) return reply.code(404).send({ error: "User not found" });
      return reply.code(204).send();
    },
  );
}
