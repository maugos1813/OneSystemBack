import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createFleetAdmin, listFleetDetails, setFleetLogo } from "../../services/fleet.service.js";
import { logoSchema, logoTagSchema } from "../../services/orgLogo.js";
import { fleetAdminBody, fleetLogoBody, isUniqueViolation } from "./fleets.routes.js";
import { createClientOrganization, getOrganizationBrief, getOrganizationDetail, getPlatformFleet, listOrganizations, setOrganizationLogo, setOrganizationSections, setUserLogo } from "../../services/platform.service.js";
import { requireAuth, requirePlatform } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];
const PLATFORM = { onRequest: requireAuth, preHandler: requirePlatform };

const createClientSchema = z.object({
  orgName: z.string().min(2).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  logo: logoSchema.optional(),
});

/** Cross-client administration. Only OneSystec's own organization gets past `requirePlatform`; clients never see these. */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/platform/organizations",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Todas las organizaciones (solo OneSystec)", security: AUTH } },
    async () => listOrganizations(),
  );

  // OneSystec's own map: every device of every client, with its latest position.
  app.get(
    "/platform/fleet",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Todos los vehículos y dispositivos de todos los clientes, con su última posición (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      // A read-only look at one client is that client's account, not OneSystec's overview.
      if (request.user.viewAs) return reply.code(403).send({ error: "Forbidden" });
      return getPlatformFleet();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/platform/organizations/:id",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Detalle de una organización (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid id" });
      const detail = await getOrganizationDetail(parsed.data);
      if (!detail) return reply.code(404).send({ error: "Organization not found" });
      return detail;
    },
  );

  // "See the client's map in one click": a short-lived token that carries the client's organization but only lets OneSystec read.
  app.post<{ Params: { id: string } }>(
    "/platform/organizations/:id/view",
    {
      ...PLATFORM,
      schema: { tags: ["Platform"], summary: "Token de solo lectura para ver la cuenta de un cliente (solo OneSystec)", security: AUTH },
    },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse(request.params.id);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid id" });
      const org = await getOrganizationBrief(parsed.data);
      if (!org) return reply.code(404).send({ error: "Organization not found" });
      const token = app.jwt.sign(
        { userId: request.user.userId, orgId: org.id, role: "admin", allowedArea: null, viewAs: true },
        { expiresIn: "2h" },
      );
      return { token, orgId: org.id, orgName: org.name };
    },
  );

  // What a client may have: OneSystec decides its OneTrack sections and administration pages.
  app.patch<{ Params: { id: string } }>(
    "/platform/organizations/:id/sections",
    {
      ...PLATFORM,
      schema: { tags: ["Platform"], summary: "Fijar las secciones que un cliente puede tener; null quita el límite (solo OneSystec)", security: AUTH },
    },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      const body = z.object({ sections: z.array(z.string().max(30)).max(40).nullable() }).safeParse(request.body);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const updated = await setOrganizationSections(id.data, body.data.sections);
      if (!updated) return reply.code(404).send({ error: "Organization not found" });
      return updated;
    },
  );

  // The fleets of a client: what it has, the picture of each, and the account that administers each. Same data the client sees in its own team page.
  app.get<{ Params: { id: string } }>(
    "/platform/organizations/:id/fleets",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Las flotas de un cliente (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      return listFleetDetails(id.data);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/platform/organizations/:id/fleets/logo",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Imagen de una flota de un cliente (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      const body = fleetLogoBody.safeParse(request.body);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      if (!(await getOrganizationBrief(id.data))) return reply.code(404).send({ error: "Organization not found" });
      return setFleetLogo(id.data, body.data.name, body.data.logo, body.data.logo === null ? null : (body.data.tag ?? null));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/platform/organizations/:id/fleets/admin",
    { ...PLATFORM, schema: { tags: ["Platform"], summary: "Cuenta que administra una flota de un cliente (solo OneSystec)", security: AUTH } },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      const body = fleetAdminBody.safeParse(request.body);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      if (!(await getOrganizationBrief(id.data))) return reply.code(404).send({ error: "Organization not found" });
      const { fleet, ...account } = body.data;
      try {
        return reply.code(201).send(await createFleetAdmin(id.data, fleet, account));
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: "Email already registered" });
        throw err;
      }
    },
  );

  // The company logo of a client.
  app.patch<{ Params: { id: string } }>(
    "/platform/organizations/:id/logo",
    {
      ...PLATFORM,
      schema: { tags: ["Platform"], summary: "Poner o quitar el logo de la empresa de un cliente (solo OneSystec)", security: AUTH },
    },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.id);
      const body = z.object({ logo: logoSchema.nullable(), tag: logoTagSchema.nullable().optional() }).safeParse(request.body);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const updated = await setOrganizationLogo(id.data, body.data.logo, body.data.logo === null ? null : (body.data.tag ?? null));
      if (!updated) return reply.code(404).send({ error: "Organization not found" });
      return updated;
    },
  );

  // The photo (logo) of a client's user, e.g. the account holder of a client: OneSystec sets it for them.
  app.patch<{ Params: { userId: string } }>(
    "/platform/users/:userId/logo",
    {
      ...PLATFORM,
      schema: { tags: ["Platform"], summary: "Poner o quitar la foto de un usuario de un cliente (solo OneSystec)", security: AUTH },
    },
    async (request, reply) => {
      const id = z.string().uuid().safeParse(request.params.userId);
      const body = z.object({ logo: logoSchema.nullable() }).safeParse(request.body);
      if (!id.success) return reply.code(400).send({ error: "Invalid id" });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const updated = await setUserLogo(id.data, body.data.logo);
      if (!updated) return reply.code(404).send({ error: "User not found" });
      return updated;
    },
  );

  app.post(
    "/platform/organizations",
    {
      ...PLATFORM,
      schema: {
        tags: ["Platform"],
        summary: "Dar de alta un cliente nuevo con su primer usuario (solo OneSystec)",
        security: AUTH,
        body: zodToJsonSchema(createClientSchema),
      },
    },
    async (request, reply) => {
      const parsed = createClientSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const { orgId, user } = await createClientOrganization(parsed.data);
        return reply.code(201).send({ orgId, userId: user.id });
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
          return reply.code(409).send({ error: "Email already registered" });
        }
        throw err;
      }
    },
  );
}
