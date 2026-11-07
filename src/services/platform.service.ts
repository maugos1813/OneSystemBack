import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, organizations, users, vehicles } from "../db/schema/index.js";
import { env } from "../config/env.js";
import { registerOrganizationWithOwner } from "./auth.service.js";

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
  members: Array<{ id: string; name: string; email: string; role: string; allowedArea: string | null }>;
  deviceList: Array<{
    id: string;
    imei: string;
    model: string;
    status: string;
    lastSeenAt: Date | null;
    vehicle: { name: string; plate: string | null } | null;
  }>;
}

export async function getOrganizationDetail(id: string): Promise<OrganizationDetail | undefined> {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!org) return undefined;
  const summary = (await listOrganizations()).find((row) => row.id === id);
  if (!summary) return undefined;
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, allowedArea: users.allowedArea })
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
  return { ...summary, members, deviceList };
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
