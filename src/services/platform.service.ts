import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, organizations, users } from "../db/schema/index.js";
import { env } from "../config/env.js";
import { registerOrganizationWithOwner } from "./auth.service.js";

/**
 * The platform is OneSystec itself: the organization(s) listed in PLATFORM_ORG_IDS. Everyone else is a client, and a
 * client never sees across organizations. Fail closed: with the variable unset, nobody is the platform.
 */
export function platformOrgIds(raw: string | undefined = env.PLATFORM_ORG_IDS): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformOrg(orgId: string | undefined | null, raw?: string): boolean {
  return !!orgId && platformOrgIds(raw).includes(orgId.toLowerCase());
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
  isPlatform: boolean;
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
    isPlatform: isPlatformOrg(row.id),
  }));
}

export interface OrganizationDetail extends OrganizationSummary {
  members: Array<{ id: string; name: string; email: string; role: string; allowedArea: string | null }>;
  deviceList: Array<{ id: string; imei: string; model: string; status: string; lastSeenAt: Date | null }>;
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
  const deviceList = await db
    .select({ id: devices.id, imei: devices.imei, model: devices.model, status: devices.status, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.orgId, id))
    .orderBy(asc(devices.createdAt));
  return { ...summary, members, deviceList };
}

/** A new client: its organization with its first user (the owner), same as the public sign-up but done by OneSystec. */
export async function createClientOrganization(input: { orgName: string; email: string; password: string; logo?: string }) {
  return registerOrganizationWithOwner(input);
}
