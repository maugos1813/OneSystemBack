import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createSim,
  deleteSim,
  getSimSecrets,
  listSims,
  normalizeIccid,
  normalizePhone,
  SimError,
  updateSim,
} from "../../services/sim.service.js";
import { isForeignKeyViolation } from "../pgError.js";
import { requireAuth, requirePlatform, requireRole } from "../middlewares/auth.middleware.js";

/**
 * SIM cards of the org's trackers. The whole section is owner/admin only and needs an
 * org-wide (non área-restricted) account: it holds credentials (PIN/PUK) and isn't scoped
 * to a fleet área. API keys never reach it (they're limited to vehicle-data reads).
 */

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

/** An optional text field where "" means "clear it". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const iccid = z
  .string()
  .transform((value, ctx) => {
    const normalized = normalizeIccid(value);
    if (!normalized) ctx.addIssue({ code: "custom", message: "ICCID inválido: 18 a 20 dígitos, con el sufijo de letras si lo trae (ej. 8939…067-K48H)" });
    return normalized ?? z.NEVER;
  });

const phone = z
  .string()
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null || value.trim() === "") return value === undefined ? undefined : null;
    const normalized = normalizePhone(value);
    if (!normalized) ctx.addIssue({ code: "custom", message: "Número de teléfono inválido (8 a 15 dígitos, con + opcional)" });
    return normalized ?? z.NEVER;
  });

const fields = {
  deviceId: z.string().uuid().nullable().optional(),
  operator: z.string().trim().min(1).max(50).optional(),
  phoneNumber: phone,
  nmu: optionalText(20),
  pin: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.string().regex(/^\d{4,8}$/, "El PIN son 4 a 8 dígitos").nullable().optional()),
  puk: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.string().regex(/^\d{8}$/, "El PUK son 8 dígitos").nullable().optional()),
  notes: optionalText(2000),
};

const createSchema = z.object({ ...fields, iccid });
const updateSchema = z.object({ ...fields, iccid: iccid.optional() });

/** Owner/admin, and not limited to one área. */
async function requireOrgWideAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user.allowedArea) await reply.code(403).send({ error: "SIMs are managed by organization-wide accounts" });
}

/**
 * Whose SIMs: a client's, picked by OneSystec with `?orgId=` (these routes are OneSystec's alone), or its own organization's
 * when nothing is picked. Undefined means the id isn't a valid one and the request was already answered.
 */
async function targetOrg(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const raw = (request.query as { orgId?: string } | undefined)?.orgId;
  if (raw === undefined || raw === "") return request.user.orgId;
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) {
    await reply.code(400).send({ error: "Invalid orgId" });
    return undefined;
  }
  return parsed.data;
}

function sendSimError(reply: FastifyReply, err: unknown) {
  if (err instanceof SimError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

const idParams = { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } as const;

export async function simsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  // SIMs (number, ICCID, PIN, PUK) are OneSystec's, never a client's.
  const guard = [requireRole("owner", "admin"), requirePlatform, requireOrgWideAdmin];

  app.get(
    "/sims",
    {
      preHandler: guard,
      schema: { tags: ["SIMs"], summary: "Listar las SIMs (sin PIN/PUK) (owner/admin)", security: AUTH },
    },
    async (request, reply) => {
      const orgId = await targetOrg(request, reply);
      if (!orgId) return reply;
      return listSims(orgId);
    },
  );

  app.post(
    "/sims",
    {
      preHandler: guard,
      schema: { tags: ["SIMs"], summary: "Registrar una SIM (owner/admin)", security: AUTH },
    },
    async (request, reply) => {
      const orgId = await targetOrg(request, reply);
      if (!orgId) return reply;
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      try {
        return reply.code(201).send(await createSim(orgId, parsed.data));
      } catch (err) {
        // foreign_key_violation: the organization it was meant for doesn't exist.
        if (isForeignKeyViolation(err)) {
          return reply.code(404).send({ error: "Organization not found" });
        }
        return sendSimError(reply, err);
      }
    },
  );

  app.patch(
    "/sims/:id",
    {
      preHandler: guard,
      schema: { tags: ["SIMs"], summary: "Editar una SIM; solo cambian los campos enviados (owner/admin)", security: AUTH, params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const orgId = await targetOrg(request, reply);
      if (!orgId) return reply;
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      try {
        return await updateSim(orgId, id, parsed.data);
      } catch (err) {
        return sendSimError(reply, err);
      }
    },
  );

  app.delete(
    "/sims/:id",
    {
      preHandler: guard,
      schema: { tags: ["SIMs"], summary: "Eliminar una SIM (owner/admin)", security: AUTH, params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const orgId = await targetOrg(request, reply);
      if (!orgId) return reply;
      if (!(await deleteSim(orgId, id))) return reply.code(404).send({ error: "SIM not found" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/sims/:id/secrets",
    {
      preHandler: guard,
      schema: { tags: ["SIMs"], summary: "PIN y PUK de una SIM (owner/admin)", security: AUTH, params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const orgId = await targetOrg(request, reply);
      if (!orgId) return reply;
      const secrets = await getSimSecrets(orgId, id);
      if (!secrets) return reply.code(404).send({ error: "SIM not found" });
      // Never cacheable: these are credentials.
      void reply.header("Cache-Control", "no-store");
      return secrets;
    },
  );
}
