import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, organizations, platformAccessLog, users, vehicles, type Device, type Position, type Vehicle } from "../db/schema/index.js";
import { env } from "../config/env.js";
import { registerOrganizationWithOwner } from "./auth.service.js";
import { setFleetLogo } from "./fleet.service.js";
import { sanitizeOrgSections } from "./modules.js";
import { getLatestPosition } from "./position.service.js";
import { invalidateDeviceFleets } from "../realtime/deviceFleet.js";

/**
 * The platform is OneSystec: the people whose email is in PLATFORM_ADMIN_EMAILS. An email, not an organization: OneSystec's
 * own account may well sit inside a client's organization, and then everyone else there must not inherit anything. Fail closed:
 * with the variable unset, nobody is the platform.
 */
export function platformEmails(raw: string | undefined = env.PLATFORM_ADMIN_EMAILS): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformEmail(email: string | undefined | null, raw?: string): boolean {
  return !!email && platformEmails(raw).includes(email.trim().toLowerCase());
}

/** Whether this logged-in user is one of the platform's people. Read from the database, not from the token. */
export async function isPlatformUser(userId: string): Promise<boolean> {
  if (platformEmails().length === 0) return false;
  const [row] = await db.select({ email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return !!row && (row.role === "owner" || row.role === "admin") && isPlatformEmail(row.email);
}

export interface OrganizationSummary {
  id: string;
  name: string;
  plan: string;
  createdAt: Date;
  users: number;
  vehicles: number;
  devices: number;
  /** The most recent time any of its devices reported. */
  lastDeviceSeenAt: Date | null;
}

/** Every organization with what it has, for the platform administration. Counts are done in SQL, one pass. */
export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    plan: string;
    created_at: Date;
    users: number;
    vehicles: number;
    devices: number;
    last_seen: Date | null;
  }>(sql`
    select o.id, o.name, o.plan, o.created_at,
      (select count(*)::int from users u where u.org_id = o.id) as users,
      (select count(*)::int from vehicles v where v.org_id = o.id) as vehicles,
      (select count(*)::int from devices d where d.org_id = o.id) as devices,
      (select max(d.last_seen_at) from devices d where d.org_id = o.id) as last_seen
    from organizations o
    order by o.created_at asc
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    plan: row.plan,
    createdAt: new Date(row.created_at),
    users: Number(row.users),
    vehicles: Number(row.vehicles),
    devices: Number(row.devices),
    lastDeviceSeenAt: row.last_seen ? new Date(row.last_seen) : null,
  }));
}

export interface OrganizationDetail extends OrganizationSummary {
  /** The sections this client may have (null: all of them). */
  sections: string[] | null;
  /** The company logo (data URL), shown in its top bar unless a user has a photo of their own. */
  logo: string | null;
  members: Array<{ id: string; name: string; email: string; role: string; allowedArea: string | null; logo: string | null; totpEnabled: boolean }>;
  deviceList: Array<{
    id: string;
    imei: string;
    model: string;
    status: string;
    lastSeenAt: Date | null;
    vehicle: { name: string; plate: string | null } | null;
  }>;
  /** The client's vehicles and the device each has: OneSystec is the one who assigns devices. */
  vehicleList: Array<{ id: string; name: string; plate: string | null; fleetGroup: string | null; deviceId: string | null }>;
}

export async function getOrganizationDetail(id: string): Promise<OrganizationDetail | undefined> {
  const [org] = await db.select({ id: organizations.id, modules: organizations.modules, logo: organizations.logo }).from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!org) return undefined;
  const summary = (await listOrganizations()).find((row) => row.id === id);
  if (!summary) return undefined;
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, allowedArea: users.allowedArea, logo: users.logo, totpEnabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.orgId, id))
    .orderBy(asc(users.createdAt));
  const rows = await db
    .select({
      id: devices.id,
      imei: devices.imei,
      model: devices.model,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      vehicleName: vehicles.name,
      vehiclePlate: vehicles.plate,
    })
    .from(devices)
    .leftJoin(vehicles, eq(vehicles.deviceId, devices.id))
    .where(eq(devices.orgId, id))
    .orderBy(asc(devices.createdAt));
  const deviceList = rows.map(({ vehicleName, vehiclePlate, ...device }) => ({
    ...device,
    vehicle: vehicleName ? { name: vehicleName, plate: vehiclePlate } : null,
  }));
  return {
    ...summary,
    sections: org.modules ?? null,
    logo: org.logo ?? null,
    members: members.map(({ totpEnabledAt, ...member }) => ({ ...member, totpEnabled: !!totpEnabledAt })),
    deviceList,
    vehicleList: await db
      .select({ id: vehicles.id, name: vehicles.name, plate: vehicles.plate, fleetGroup: vehicles.fleetGroup, deviceId: vehicles.deviceId })
      .from(vehicles)
      .where(eq(vehicles.orgId, id))
      .orderBy(asc(vehicles.name)),
  };
}

/** The organization that owns a device or a vehicle, found by its id alone (OneSystec's overview shows every client's). */
export async function owningOrgOf(kind: "device" | "vehicle", id: string): Promise<string | undefined> {
  const table = kind === "device" ? devices : vehicles;
  const [row] = await db.select({ orgId: table.orgId }).from(table).where(eq(table.id, id)).limit(1);
  return row?.orgId ?? undefined;
}

export class AssignDeviceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * OneSystec gives a device to a vehicle of a client (or takes it off with null). The device must be one of that client's (the
 * ones OneSystec handed over by IMEI) and not already on another vehicle.
 */
export async function assignDeviceToVehicle(orgId: string, vehicleId: string, deviceId: string | null): Promise<{ id: string; deviceId: string | null }> {
  const [vehicle] = await db.select({ id: vehicles.id }).from(vehicles).where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId))).limit(1);
  if (!vehicle) throw new AssignDeviceError(404, "Vehicle not found");
  if (deviceId) {
    const [device] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
    if (!device) throw new AssignDeviceError(404, "Device not found in this organization");
    const [taken] = await db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.deviceId, deviceId), ne(vehicles.id, vehicleId)))
      .limit(1);
    if (taken) throw new AssignDeviceError(409, "Ese dispositivo ya está en otro vehículo");
  }
  await db.update(vehicles).set({ deviceId }).where(eq(vehicles.id, vehicleId));
  invalidateDeviceFleets();
  return { id: vehicleId, deviceId };
}

/** A new client: its organization with its first user (the owner), same as the public sign-up but done by OneSystec. */
export async function createClientOrganization(input: { orgName: string; email: string; password: string; logo?: string }) {
  return registerOrganizationWithOwner(input);
}

/** Just enough of an organization to say whose account is being looked at. */
export async function getOrganizationBrief(id: string): Promise<{ id: string; name: string; logo: string | null } | undefined> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return org;
}

/** The name a device without a vehicle goes by on OneSystec's map. */
const NO_CLIENT = "Sin cliente";

export interface PlatformFleet {
  /** Every vehicle of every client, `fleetGroup` carrying the client's name; plus one stand-in for each device that has no vehicle. */
  vehicles: Array<Vehicle & { orgName: string }>;
  devices: Device[];
  /** The latest position of each vehicle above, keyed by vehicle id. */
  positions: Record<string, Position>;
  /** Each client's logo by its name (`fleetGroup` above), the small copy where there is one: what opens its plates on the map. Clients without one are left out. */
  logos: Record<string, string>;
}

/**
 * Everything OneSystec's own map needs in one answer: it hands every device out, so it must see each one, whether or not the
 * client has put it on a vehicle, and whether or not a client has claimed it yet.
 */
export async function getPlatformFleet(): Promise<PlatformFleet> {
  const [orgRows, vehicleRows, deviceRows] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name, logo: organizations.logo, logoTag: organizations.logoTag }).from(organizations),
    db.select().from(vehicles),
    db.select().from(devices),
  ]);
  const orgName = new Map(orgRows.map((org) => [org.id, org.name]));
  const withVehicle = new Set(vehicleRows.map((v) => v.deviceId).filter((id): id is string => !!id));

  const fleet: PlatformFleet["vehicles"] = vehicleRows.map((v) => {
    const client = orgName.get(v.orgId) ?? NO_CLIENT;
    return { ...v, fleetGroup: client, orgName: client };
  });
  for (const device of deviceRows) {
    if (withVehicle.has(device.id)) continue;
    const client = (device.orgId && orgName.get(device.orgId)) || NO_CLIENT;
    fleet.push({
      id: device.id, // a stand-in vehicle: the device's own id is unique and never collides with a real vehicle's
      orgId: device.orgId ?? "",
      name: `Sin vehículo · ${device.imei}`,
      plate: null,
      fleetGroup: client,
      deviceId: device.id,
      odometerOffsetKm: 0,
      brand: null,
      model: device.model,
      year: null,
      vin: null,
      fuelType: null,
      color: null,
      notes: null,
      odometerMode: "auto",
      odometerBaseKm: null,
      odometerBaseAt: null,
      kmFactor: 1,
      kmFactorAt: null,
      odometerBaseDayKm: null,
      outOfService: false,
      outOfServiceAt: null,
      createdAt: device.createdAt,
      orgName: client,
    });
  }

  const positions: Record<string, Position> = {};
  await Promise.all(
    fleet.map(async (vehicle) => {
      if (!vehicle.deviceId) return;
      const latest = await getLatestPosition(vehicle.deviceId);
      if (latest) positions[vehicle.id] = latest;
    }),
  );
  const logos: Record<string, string> = {};
  for (const org of orgRows) if (org.logoTag ?? org.logo) logos[org.name] = (org.logoTag ?? org.logo) as string;
  return { vehicles: fleet, devices: deviceRows, positions, logos };
}

/**
 * Puts or removes the profile photo of any user, in any client: it is OneSystec who gives each client its identity. For an account limited
 * to a fleet the photo is the fleet's picture on the map, so it is kept there too, with its small copy.
 */
export async function setUserLogo(userId: string, logo: string | null, tag: string | null = null): Promise<{ id: string; logo: string | null } | undefined> {
  const [updated] = await db
    .update(users)
    .set({ logo })
    .where(eq(users.id, userId))
    .returning({ id: users.id, logo: users.logo, orgId: users.orgId, area: users.allowedArea });
  if (!updated) return undefined;
  if (updated.area) await setFleetLogo(updated.orgId, updated.area, logo, tag);
  return { id: updated.id, logo: updated.logo };
}

/** What a client may have, set by OneSystec: the OneTrack sections and administration pages. Null lifts the limit. */
export async function setOrganizationSections(id: string, sections: readonly string[] | null): Promise<{ sections: string[] | null } | undefined> {
  const clean = sanitizeOrgSections(sections);
  const [updated] = await db.update(organizations).set({ modules: clean }).where(eq(organizations.id, id)).returning({ modules: organizations.modules });
  return updated ? { sections: updated.modules ?? null } : undefined;
}

/** Puts or removes the company logo of a client: OneSystec gives each client its identity. */
export async function setOrganizationLogo(id: string, logo: string | null, tag: string | null = null): Promise<{ id: string; logo: string | null } | undefined> {
  const [updated] = await db.update(organizations).set({ logo, logoTag: tag }).where(eq(organizations.id, id)).returning({ id: organizations.id, logo: organizations.logo });
  return updated;
}

/** Records that one of OneSystec's people opened a client's account ("view", "manage") or changed something in it ("write"). Never blocks what it records. */
export async function logPlatformAccess(userId: string, orgId: string, action: "view" | "manage" | "write", detail?: string): Promise<void> {
  try {
    await db.insert(platformAccessLog).values({ userId, orgId, action, detail: detail?.slice(0, 200) ?? null });
  } catch {
    // The log is a safeguard, not a gate: if it cannot be written the person is not locked out of their own work.
  }
}

/** The latest accesses to a client's account, newest first, with who made each one. */
export async function listPlatformAccess(orgId: string, limit = 100) {
  return db
    .select({
      id: platformAccessLog.id,
      action: platformAccessLog.action,
      detail: platformAccessLog.detail,
      createdAt: platformAccessLog.createdAt,
      userEmail: users.email,
    })
    .from(platformAccessLog)
    .leftJoin(users, eq(users.id, platformAccessLog.userId))
    .where(eq(platformAccessLog.orgId, orgId))
    .orderBy(desc(platformAccessLog.createdAt))
    .limit(limit);
}
