import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, simCards, vehicles, type SimCard } from "../db/schema/index.js";

/** ICCID as printed by the operator: 18-20 digits, sometimes followed by letters (TIM: "…1067-K48H"). */
const ICCID_PATTERN = /^(\d{18,20})(?:-?([A-Z0-9]{1,8}))?$/;

export function normalizeIccid(input: string): string | null {
  const match = ICCID_PATTERN.exec(input.replace(/\s+/g, "").toUpperCase());
  if (!match) return null;
  return match[2] ? `${match[1]}-${match[2]}` : match[1]!;
}

/** Phone number as typed, minus separators; an optional leading "+" and 8-15 digits. */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s().-]/g, "");
  return /^\+?\d{8,15}$/.test(cleaned) ? cleaned : null;
}

export class SimError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** What leaves the server about a SIM. PIN/PUK are deliberately absent: only whether they
 * are set — their values come from getSimSecrets(), an explicit and separate read. */
export interface SimView {
  id: string;
  deviceId: string | null;
  device: { imei: string; model: string } | null;
  vehicle: { id: string; name: string; plate: string | null } | null;
  operator: string;
  iccid: string;
  phoneNumber: string | null;
  nmu: string | null;
  hasPin: boolean;
  hasPuk: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SimRow {
  sim: SimCard;
  imei: string | null;
  model: string | null;
  vehicleId: string | null;
  vehicleName: string | null;
  plate: string | null;
}

export function toSimView({ sim, imei, model, vehicleId, vehicleName, plate }: SimRow): SimView {
  return {
    id: sim.id,
    deviceId: sim.deviceId,
    device: imei ? { imei, model: model ?? "" } : null,
    vehicle: vehicleId ? { id: vehicleId, name: vehicleName ?? "", plate } : null,
    operator: sim.operator,
    iccid: sim.iccid,
    phoneNumber: sim.phoneNumber,
    nmu: sim.nmu,
    hasPin: sim.pin !== null,
    hasPuk: sim.puk !== null,
    notes: sim.notes,
    createdAt: sim.createdAt,
    updatedAt: sim.updatedAt,
  };
}

function selectSims() {
  return db
    .select({
      sim: simCards,
      imei: devices.imei,
      model: devices.model,
      vehicleId: vehicles.id,
      vehicleName: vehicles.name,
      plate: vehicles.plate,
    })
    .from(simCards)
    .leftJoin(devices, eq(simCards.deviceId, devices.id))
    .leftJoin(vehicles, eq(vehicles.deviceId, devices.id));
}

export async function listSims(orgId: string): Promise<SimView[]> {
  const rows = await selectSims().where(eq(simCards.orgId, orgId)).orderBy(asc(simCards.createdAt));
  return rows.map(toSimView);
}

async function getSimView(orgId: string, id: string): Promise<SimView | undefined> {
  const [row] = await selectSims()
    .where(and(eq(simCards.id, id), eq(simCards.orgId, orgId)))
    .limit(1);
  return row ? toSimView(row) : undefined;
}

export interface SimInput {
  deviceId?: string | null;
  operator?: string;
  iccid?: string;
  phoneNumber?: string | null;
  nmu?: string | null;
  pin?: string | null;
  puk?: string | null;
  notes?: string | null;
}

/** The tracker must belong to the org, and must not already have another SIM. */
async function assertDeviceAvailable(orgId: string, deviceId: string, exceptSimId?: string): Promise<void> {
  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  if (!device) throw new SimError(400, "Device not found in your organization");

  const taken = await db
    .select({ id: simCards.id })
    .from(simCards)
    .where(exceptSimId ? and(eq(simCards.deviceId, deviceId), ne(simCards.id, exceptSimId)) : eq(simCards.deviceId, deviceId))
    .limit(1);
  if (taken.length > 0) throw new SimError(409, "That device already has a SIM assigned");
}

async function assertIccidFree(orgId: string, iccid: string, exceptSimId?: string): Promise<void> {
  const taken = await db
    .select({ id: simCards.id })
    .from(simCards)
    .where(
      exceptSimId
        ? and(eq(simCards.orgId, orgId), eq(simCards.iccid, iccid), ne(simCards.id, exceptSimId))
        : and(eq(simCards.orgId, orgId), eq(simCards.iccid, iccid)),
    )
    .limit(1);
  if (taken.length > 0) throw new SimError(409, "A SIM with that ICCID is already registered");
}

export async function createSim(orgId: string, input: SimInput & { iccid: string }): Promise<SimView> {
  await assertIccidFree(orgId, input.iccid);
  if (input.deviceId) await assertDeviceAvailable(orgId, input.deviceId);

  const [created] = await db
    .insert(simCards)
    .values({
      orgId,
      deviceId: input.deviceId ?? null,
      operator: input.operator ?? "TIM",
      iccid: input.iccid,
      phoneNumber: input.phoneNumber ?? null,
      nmu: input.nmu ?? null,
      pin: input.pin ?? null,
      puk: input.puk ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: simCards.id });
  return (await getSimView(orgId, created!.id))!;
}

export async function updateSim(orgId: string, id: string, input: SimInput): Promise<SimView> {
  const [existing] = await db
    .select({ id: simCards.id })
    .from(simCards)
    .where(and(eq(simCards.id, id), eq(simCards.orgId, orgId)))
    .limit(1);
  if (!existing) throw new SimError(404, "SIM not found");

  if (input.iccid) await assertIccidFree(orgId, input.iccid, id);
  if (input.deviceId) await assertDeviceAvailable(orgId, input.deviceId, id);

  // Only the fields that were sent change; `null` clears an optional one.
  const patch: Partial<typeof simCards.$inferInsert> = { updatedAt: new Date() };
  for (const key of ["deviceId", "operator", "iccid", "phoneNumber", "nmu", "pin", "puk", "notes"] as const) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  await db.update(simCards).set(patch).where(and(eq(simCards.id, id), eq(simCards.orgId, orgId)));
  return (await getSimView(orgId, id))!;
}

export async function deleteSim(orgId: string, id: string): Promise<boolean> {
  const result = await db.delete(simCards).where(and(eq(simCards.id, id), eq(simCards.orgId, orgId)));
  return (result.rowCount ?? 0) > 0;
}

export async function getSimSecrets(orgId: string, id: string): Promise<{ pin: string | null; puk: string | null } | undefined> {
  const [row] = await db
    .select({ pin: simCards.pin, puk: simCards.puk })
    .from(simCards)
    .where(and(eq(simCards.id, id), eq(simCards.orgId, orgId)))
    .limit(1);
  return row;
}
