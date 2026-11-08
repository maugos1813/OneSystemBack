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
  updateTeamMemberLogo,
  updateTeamMemberLanguage,
  updateTeamMemberModules,
  updateTeamMemberName,
  updateTeamMemberPassword,
  updateTeamMemberProducts,
  updateTeamMemberRole,
} from "../../services/teamUser.service.js";
import { LANGUAGES, toLanguage } from "../../services/i18n.js";
import { MODULE_KEYS } from "../../services/modules.js";
import { logoSchema, logoTagSchema } from "../../services/orgLogo.js";
import { getUserModules } from "../../services/userModules.service.js";
import { disableTotp } from "../../services/mfa.service.js";
import { revokeAllUserSessions } from "../../services/userSession.service.js";
import { isUniqueViolation } from "../pgError.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
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
  logo: logoSchema.nullable().optional(),
  logoTag: logoTagSchema.nullable().optional(),
  modules: z.array(z.enum(MODULE_KEYS)).optional(),
  language: z.enum(LANGUAGES).optional(),
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

const updateModulesSchema = z.object({
  modules: z.array(z.enum(MODULE_KEYS)),
});

const updateLanguageSchema = z.object({
  language: z.enum(LANGUAGES),
});

const updateLogoSchema = z.object({
  logo: logoSchema.nullable(),
  /** The small copy of the logo, for the map's plate tags. */
  tag: logoTagSchema.nullable().optional(),
});

const updateEmailSchema = z.object({
  email: z.string().email(),
});

const updatePasswordSchema = z.object({
  password: z.string().min(8).max(100),
});

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

          const ownModules = await getUserModules(request.user.userId);
          if (data.modules && !data.modules.every((m) => ownModules.includes(m))) {
            return reply.code(400).send({ error: "Can't grant a section you don't have yourself" });
          }

          const member = await createTeamMember({
            orgId: request.user.orgId,
            name: data.name,
            email: data.email,
            password: data.password,
            role: "viewer",
            parentUserId: request.user.userId,
            allowedArea,
            logo: data.logo ?? null,
            modules: data.modules ?? ownModules,
            // A sub-user reads the app in the language of the manager who created them, unless told otherwise.
            language: data.language ?? toLanguage((await getTeamMember(request.user.orgId, request.user.userId))?.language),
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
          logo: data.logo ?? null,
          logoTag: data.logoTag ?? null,
          modules: data.modules,
          language: data.language,
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
    "/users/:id/logo",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Poner o quitar el logo de un miembro — owner/admin, o manager sobre sus propios sub-usuarios",
        security: AUTH,
        body: zodToJsonSchema(updateLogoSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      // Not self-service: the logo is the identity the admin gives a client.
      if (!canManageOther(request.user, target)) return reply.code(403).send({ error: "Forbidden" });

      const parsed = updateLogoSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await updateTeamMemberLogo(request.user.orgId, id, parsed.data.logo, parsed.data.logo === null ? null : (parsed.data.tag ?? null));
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, logo: updated.logo };
    },
  );

  app.patch(
    "/users/:id/modules",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Elegir qué secciones de OneTrack ve un miembro — owner/admin, o manager sobre sus propios sub-usuarios",
        security: AUTH,
        body: zodToJsonSchema(updateModulesSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!canManageOther(request.user, target)) return reply.code(403).send({ error: "Forbidden" });

      const parsed = updateModulesSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      if (request.user.role === "manager") {
        const ownModules = await getUserModules(request.user.userId);
        if (!parsed.data.modules.every((m) => ownModules.includes(m))) {
          return reply.code(400).send({ error: "Can't grant a section you don't have yourself" });
        }
      }

      const updated = await updateTeamMemberModules(request.user.orgId, id, parsed.data.modules);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, modules: updated.modules ?? [] };
    },
  );

  app.patch(
    "/users/:id/language",
    {
      preHandler: MANAGE_MEMBERS,
      schema: {
        tags: ["Team"],
        summary: "Elegir el idioma (español/italiano) en que un miembro ve la app y recibe los avisos",
        security: AUTH,
        body: zodToJsonSchema(updateLanguageSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (!canManageOther(request.user, target)) return reply.code(403).send({ error: "Forbidden" });

      const parsed = updateLanguageSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const updated = await updateTeamMemberLanguage(request.user.orgId, id, parsed.data.language);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return { id: updated.id, language: toLanguage(updated.language) };
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
      // A new password is the usual answer to "someone else may have it": every other device is signed out (the one that
      // changed it stays, when it is the person themselves).
      await revokeAllUserSessions(id, isSelf ? request.user.sid : undefined);
      return reply.code(204).send();
    },
  );

  // A lost phone: whoever manages this member removes their authenticator, and it is set up again at their next sign-in (an
  // admin is made to). Only the owner may do it to an admin, and nobody to the owner (OneSystec does that one).
  app.post(
    "/users/:id/totp/reset",
    {
      preHandler: MANAGE_MEMBERS,
      schema: { tags: ["Team"], summary: "Quitar el autenticador de un miembro (teléfono perdido)", security: AUTH },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await getTeamMember(request.user.orgId, id);
      if (!target) return reply.code(404).send({ error: "User not found" });
      if (id === request.user.userId || !canManageOther(request.user, target)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (target.role === "admin" && request.user.role !== "owner") {
        return reply.code(403).send({ error: "Solo el titular de la cuenta puede restablecer el autenticador de un administrador" });
      }
      await disableTotp(id);
      await revokeAllUserSessions(id);
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
