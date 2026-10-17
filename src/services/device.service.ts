import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, positions, simCards, vehicles, type Device, type DeviceEvent } from "../db/schema/index.js";
import { collectLatestIo, type IoReading } from "./deviceIo.js";
import { getDeviceEvents } from "./position.service.js";

/** How many of the newest position rows are scanned for the "what is this device sending" list. */
const IO_SCAN_ROWS = 100;
const DETAIL_EVENTS = 30;

/** Looks up a device by IMEI, auto-creating an "unclaimed" row on first contact. */
export async function findOrCreateDeviceByImei(imei: string): Promise<Device> {
  const [existing] = await db.select().from(devices).where(eq(devices.imei, imei)).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(devices).values({ imei }).returning();
  return created!;
}

export async function touchLastSeen(deviceId: string): Promise<void> {
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}

/** A real IMEI: 15 digits whose last one is the Luhn check digit — catches a mistyped digit. */
export function isValidImei(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = Number(imei[14 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Claims a device into an organization. An unclaimed device (one that already connected) is
 * taken over; an IMEI never seen before is registered straight into the organization, so a tracker
 * can be added before it has a SIM and ever connects — when it first does, it finds its row.
 * Undefined if the device belongs to another organization (or the unknown IMEI isn't a valid one).
 */
export async function claimDevice(orgId: string, imei: string, model?: string): Promise<Device | undefined> {
  const take = async () => {
    const [updated] = await db
      .update(devices)
      .set({ orgId, status: "active", ...(model ? { model } : {}) })
      .where(and(eq(devices.imei, imei), isNull(devices.orgId)))
      .returning();
    return updated;
  };

  const taken = await take();
  if (taken || !isValidImei(imei)) return taken;

  const [created] = await db
    .insert(devices)
    .values({ imei, orgId, status: "active", ...(model ? { model } : {}) })
    .onConflictDoNothing({ target: devices.imei })
    .returning();
  // Lost a race with the device connecting for the first time: it exists now, unclaimed.
  return created ?? (await take());
}

/** `allowedArea` excludes devices outside that área entirely — including any device
 * with no vehicle assigned at all, since there's nothing to attribute it to. */
export async function listDevicesForOrg(orgId: string, allowedArea?: string | null): Promise<Device[]> {
  if (!allowedArea) {
    return db.select().from(devices).where(eq(devices.orgId, orgId));
  }

  const allowedDeviceIds = await db
    .select({ deviceId: vehicles.deviceId })
    .from(vehicles)
    .where(and(eq(vehicles.orgId, orgId), eq(vehicles.fleetGroup, allowedArea)));
  const deviceIds = allowedDeviceIds.map((v) => v.deviceId).filter((id): id is string => id !== null);
  if (deviceIds.length === 0) return [];

  return db
    .select()
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));
}

export async function getDeviceById(deviceId: string): Promise<Device | undefined> {
  const [row] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  return row;
}

export interface DevicePatch {
  model?: string;
  serialNumber?: string | null;
  firmware?: string | null;
}

/** Edits the descriptive fields of a device of this org. Undefined if it isn't theirs. */
export async function updateDevice(orgId: string, deviceId: string, patch: DevicePatch): Promise<Device | undefined> {
  if (Object.keys(patch).length === 0) return getDeviceForOrg(orgId, deviceId);
  const [updated] = await db
    .update(devices)
    .set(patch)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .returning();
  return updated;
}

async function getDeviceForOrg(orgId: string, deviceId: string): Promise<Device | undefined> {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row;
}

export interface DeviceDetail {
  device: Device;
  vehicle: { id: string; name: string; plate: string | null; fleetGroup: string | null } | null;
  /** Only filled for accounts allowed to see the SIMs section (never carries PIN/PUK). */
  sim: { id: string; operator: string; iccid: string; phoneNumber: string | null } | null;
  lastPosition: {
    ts: Date;
    lat: number;
    lng: number;
    speed: number;
    angle: number;
    altitude: number;
    satellites: number | null;
  } | null;
  io: IoReading[];
  /** The newest events (ignition, movement, tracker alarms), newest first. */
  events: DeviceEvent[];
}

/**
 * Everything the device sheet shows. An área-limited account only gets devices whose vehicle
 * belongs to its área (a device with no vehicle is out of reach for it, as in the list).
 */
export async function getDeviceDetail(
  orgId: string,
  deviceId: string,
  options: { allowedArea?: string | null; includeSim: boolean },
): Promise<DeviceDetail | undefined> {
  const device = await getDeviceForOrg(orgId, deviceId);
  if (!device) return undefined;

  const [vehicle] = await db
    .select({ id: vehicles.id, name: vehicles.name, plate: vehicles.plate, fleetGroup: vehicles.fleetGroup })
    .from(vehicles)
    .where(and(eq(vehicles.orgId, orgId), eq(vehicles.deviceId, deviceId)))
    .limit(1);
  if (options.allowedArea && vehicle?.fleetGroup !== options.allowedArea) return undefined;

  const [sim] = options.includeSim
    ? await db
        .select({ id: simCards.id, operator: simCards.operator, iccid: simCards.iccid, phoneNumber: simCards.phoneNumber })
        .from(simCards)
        .where(and(eq(simCards.orgId, orgId), eq(simCards.deviceId, deviceId)))
        .limit(1)
    : [];

  const recent = await db
    .select()
    .from(positions)
    .where(eq(positions.deviceId, deviceId))
    .orderBy(desc(positions.ts))
    .limit(IO_SCAN_ROWS);
  const newest = recent[0];
  const events = await getDeviceEvents({ deviceId, limit: DETAIL_EVENTS });

  return {
    device,
    vehicle: vehicle ?? null,
    sim: sim ?? null,
    lastPosition: newest
      ? {
          ts: newest.ts,
          lat: newest.lat,
          lng: newest.lng,
          speed: newest.speed,
          angle: newest.angle,
          altitude: newest.altitude,
          satellites: newest.satellites,
        }
      : null,
    io: collectLatestIo(recent.map((row) => ({ ts: row.ts, ioData: row.ioData as Record<string, number | string> }))),
    events,
  };
}
