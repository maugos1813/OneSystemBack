import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createFleetAdmin, listFleetDetails, listFleetPictures, setFleetLogo } from "../../services/fleet.service.js";
import { LANGUAGES } from "../../services/i18n.js";
import { logoSchema, logoTagSchema } from "../../services/orgLogo.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export const fleetName = z.string().trim().min(1).max(50);
export const fleetLogoBody = z.object({ name: fleetName, logo: logoSchema.nullable(), tag: logoTagSchema.nullable().optional() });
export const fleetAdminBody = z.object({
  fleet: fleetName,
  name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  language: z.enum(LANGUAGES).optional(),
});

/** Postgres unique_violation: that email already has an account. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

/** Owner/admin, and not limited to one fleet: the people who set up the fleets of their own organization. */
async function requireOrgWideAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.allowedArea) await reply.code(403).send({ error: "Fleets are managed by organization-wide accounts" });
}

export async function fleetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  const manage = [requireRole("owner", "admin"), requireOrgWideAdmin];

  // What the map needs to draw each plate's tag: every user of the organization, within their own fleet.
  app.get(
    "/fleets",
    { schema: { tags: ["Fleets"], summary: "Las flotas y su imagen (para las targas del mapa)", security: AUTH } },
    async (request) => listFleetPictures(request.user.orgId, request.user.allowedArea),
  );

  app.get(
    "/fleets/manage",
    { preHandler: manage, schema: { tags: ["Fleets"], summary: "Las flotas con sus vehículos y sus administradores (owner/admin)", security: AUTH } },
    async (request) => listFleetDetails(request.user.orgId),
  );

  app.put(
    "/fleets/logo",
    { preHandler: manage, schema: { tags: ["Fleets"], summary: "Poner o quitar la imagen de una flota (owner/admin)", security: AUTH } },
    async (request, reply) => {
      const parsed = fleetLogoBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return setFleetLogo(request.user.orgId, parsed.data.name, parsed.data.logo, parsed.data.logo === null ? null : (parsed.data.tag ?? null));
    },
  );

  app.post(
    "/fleets/admin",
    { preHandler: manage, schema: { tags: ["Fleets"], summary: "Crear la cuenta que administra una flota (owner/admin)", security: AUTH } },
    async (request, reply) => {
      const parsed = fleetAdminBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const { fleet, ...account } = parsed.data;
      try {
        return reply.code(201).send(await createFleetAdmin(request.user.orgId, fleet, account));
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: "Email already registered" });
        throw err;
      }
    },
  );
}
