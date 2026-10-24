import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createDocument,
  deleteDocument,
  DocumentError,
  listVehicleDocuments,
  updateDocument,
} from "../../services/vehicleDocument.service.js";
import { DOCUMENT_KINDS } from "../../services/vehicleDocuments.js";
import { requireAuth, requireModule } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida").refine((value) => !Number.isNaN(Date.parse(value)), "Fecha inválida");

const documentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  label: z.string().trim().max(100).nullable().optional(),
  expiresOn: day,
  remindDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const patchSchema = documentSchema.partial();
const idParams = z.object({ id: z.string().uuid() });

export async function vehicleDocumentsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  // Owner and admin always pass; a client needs the "vencimientos" section, and only ever reaches their own flota.
  app.addHook("preHandler", requireModule("vencimientos"));

  function handleError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof DocumentError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }

  app.get(
    "/vehicle-documents",
    { schema: { tags: ["Vencimientos"], summary: "Documentos de cada vehículo visible y cuánto falta para que venzan", security: AUTH } },
    async (request) => listVehicleDocuments(request.user.orgId, request.user.allowedArea),
  );

  app.post(
    "/vehicles/:id/documents",
    {
      schema: {
        tags: ["Vencimientos"],
        summary: "Agregar un documento con vencimiento a un vehículo",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        body: zodToJsonSchema(documentSchema),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = documentSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: body.success ? "Invalid vehicle id" : body.error.flatten() });
      try {
        return reply.code(201).send(await createDocument(request.user.orgId, request.user.allowedArea, params.data.id, body.data));
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.patch(
    "/vehicle-documents/:id",
    {
      schema: {
        tags: ["Vencimientos"],
        summary: "Editar un documento (tipo, fecha, aviso, notas)",
        security: AUTH,
        params: zodToJsonSchema(idParams),
        body: zodToJsonSchema(patchSchema),
      },
    },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = patchSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: body.success ? "Invalid id" : body.error.flatten() });
      try {
        return await updateDocument(request.user.orgId, request.user.allowedArea, params.data.id, body.data);
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  app.delete(
    "/vehicle-documents/:id",
    { schema: { tags: ["Vencimientos"], summary: "Eliminar un documento", security: AUTH, params: zodToJsonSchema(idParams) } },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid id" });
      try {
        await deleteDocument(request.user.orgId, request.user.allowedArea, params.data.id);
        return reply.code(204).send();
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
