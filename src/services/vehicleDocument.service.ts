import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { vehicleDocuments, type VehicleDocument } from "../db/schema/index.js";
import { documentName, documentStatus, type DocumentStatus } from "./vehicleDocuments.js";
import { getVehicleForOrg, listVehiclesForOrg } from "./vehicle.service.js";

export class DocumentError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

export interface DocumentView {
  id: string;
  vehicleId: string;
  kind: string;
  label: string | null;
  /** What to show: the kind's name, or the label of an "otro". */
  name: string;
  expiresOn: string;
  remindDays: number;
  notes: string | null;
  status: DocumentStatus;
}

export interface VehicleDocumentsView {
  vehicleId: string;
  name: string;
  plate: string | null;
  documents: DocumentView[];
}

export function toDocumentView(doc: VehicleDocument, now: Date): DocumentView {
  return {
    id: doc.id,
    vehicleId: doc.vehicleId,
    kind: doc.kind,
    label: doc.label,
    name: documentName(doc.kind, doc.label),
    expiresOn: doc.expiresOn,
    remindDays: doc.remindDays,
    notes: doc.notes,
    status: documentStatus(doc.expiresOn, doc.remindDays, now),
  };
}

/** Every vehicle the caller can see, each with its documents (soonest to expire first). */
export async function listVehicleDocuments(
  orgId: string,
  allowedArea: string | null | undefined,
  now: Date = new Date(),
): Promise<VehicleDocumentsView[]> {
  const visible = await listVehiclesForOrg(orgId, allowedArea);
  if (visible.length === 0) return [];
  const docs = await db
    .select()
    .from(vehicleDocuments)
    .where(
      and(
        eq(vehicleDocuments.orgId, orgId),
        inArray(
          vehicleDocuments.vehicleId,
          visible.map((v) => v.id),
        ),
      ),
    )
    .orderBy(asc(vehicleDocuments.expiresOn));
  return visible
    .map((vehicle) => ({
      vehicleId: vehicle.id,
      name: vehicle.name,
      plate: vehicle.plate,
      documents: docs.filter((d) => d.vehicleId === vehicle.id).map((d) => toDocumentView(d, now)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface DocumentInput {
  kind: string;
  label?: string | null;
  expiresOn: string;
  remindDays?: number;
  notes?: string | null;
}

export async function createDocument(
  orgId: string,
  allowedArea: string | null | undefined,
  vehicleId: string,
  input: DocumentInput,
  now: Date = new Date(),
): Promise<DocumentView> {
  // A vehicle outside the caller's área does not exist for them.
  if (!(await getVehicleForOrg(orgId, vehicleId, allowedArea))) throw new DocumentError(404, "Vehicle not found");
  if (input.kind === "otro" && !input.label?.trim()) throw new DocumentError(400, "Ponle un nombre al documento");
  const [row] = await db
    .insert(vehicleDocuments)
    .values({
      orgId,
      vehicleId,
      kind: input.kind,
      label: input.kind === "otro" ? input.label!.trim() : null,
      expiresOn: input.expiresOn,
      remindDays: input.remindDays ?? 30,
      notes: input.notes ?? null,
    })
    .returning();
  return toDocumentView(row!, now);
}

async function requireDocument(orgId: string, allowedArea: string | null | undefined, id: string): Promise<VehicleDocument> {
  const [doc] = await db
    .select()
    .from(vehicleDocuments)
    .where(and(eq(vehicleDocuments.id, id), eq(vehicleDocuments.orgId, orgId)))
    .limit(1);
  if (!doc || !(await getVehicleForOrg(orgId, doc.vehicleId, allowedArea))) throw new DocumentError(404, "Document not found");
  return doc;
}

export async function updateDocument(
  orgId: string,
  allowedArea: string | null | undefined,
  id: string,
  patch: Partial<DocumentInput>,
  now: Date = new Date(),
): Promise<DocumentView> {
  const current = await requireDocument(orgId, allowedArea, id);
  const kind = patch.kind ?? current.kind;
  const label = kind === "otro" ? (patch.label !== undefined ? patch.label : current.label) : null;
  if (kind === "otro" && !label?.trim()) throw new DocumentError(400, "Ponle un nombre al documento");
  const [row] = await db
    .update(vehicleDocuments)
    .set({
      kind,
      label: kind === "otro" ? label!.trim() : null,
      ...(patch.expiresOn !== undefined ? { expiresOn: patch.expiresOn } : {}),
      ...(patch.remindDays !== undefined ? { remindDays: patch.remindDays } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      updatedAt: now,
    })
    .where(eq(vehicleDocuments.id, id))
    .returning();
  return toDocumentView(row!, now);
}

export async function deleteDocument(orgId: string, allowedArea: string | null | undefined, id: string): Promise<void> {
  await requireDocument(orgId, allowedArea, id);
  await db.delete(vehicleDocuments).where(eq(vehicleDocuments.id, id));
}

/** All documents of an organization — what the alert evaluator walks each tick. */
export async function listDocumentsForOrg(orgId: string): Promise<VehicleDocument[]> {
  return db.select().from(vehicleDocuments).where(eq(vehicleDocuments.orgId, orgId));
}
