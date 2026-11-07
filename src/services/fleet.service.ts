import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { fleets, users, vehicles } from "../db/schema/index.js";
import { createTeamMember } from "./teamUser.service.js";

export interface FleetSummary {
  name: string;
  logo: string | null;
}

/** What a map needs for a fleet: its name and the small picture that opens each plate. */
export interface FleetTag {
  name: string;
  tag: string | null;
}

export interface FleetDetail extends FleetSummary {
  vehicles: number;
  /** The accounts that administer this fleet: users limited to it (their `allowedArea`). */
  admins: Array<{ id: string; name: string; email: string; role: string }>;
}

const clean = (name: string): string => name.trim();

/**
 * The fleets of an organization, from what the system already has: the fleets its vehicles belong to, the ones users are limited to,
 * and the ones that already have a picture. `onlyArea` narrows the answer to one (an account limited to its own fleet).
 */
async function readFleets(orgId: string, onlyArea?: string | null): Promise<Array<FleetDetail & { tag: string | null }>> {
  const [fromVehicles, fromRows, accounts] = await Promise.all([
    db
      .select({ name: vehicles.fleetGroup, n: sql<number>`count(*)::int` })
      .from(vehicles)
      .where(and(eq(vehicles.orgId, orgId), isNotNull(vehicles.fleetGroup)))
      .groupBy(vehicles.fleetGroup),
    db.select().from(fleets).where(eq(fleets.orgId, orgId)),
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, area: users.allowedArea })
      .from(users)
      .where(and(eq(users.orgId, orgId), isNotNull(users.allowedArea), ne(users.allowedArea, ""))),
  ]);

  const byName = new Map<string, FleetDetail & { tag: string | null }>();
  const ensure = (raw: string) => {
    const name = clean(raw);
    let fleet = byName.get(name);
    if (!fleet) {
      fleet = { name, logo: null, tag: null, vehicles: 0, admins: [] };
      byName.set(name, fleet);
    }
    return fleet;
  };
  for (const row of fromVehicles) if (row.name) ensure(row.name).vehicles = row.n;
  for (const row of fromRows) {
    const fleet = ensure(row.name);
    fleet.logo = row.logo;
    fleet.tag = row.logoTag;
  }
  for (const account of accounts) if (account.area) ensure(account.area).admins.push({ id: account.id, name: account.name, email: account.email, role: account.role });

  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return onlyArea ? all.filter((fleet) => fleet.name === clean(onlyArea)) : all;
}

export async function listFleetDetails(orgId: string, onlyArea?: string | null): Promise<FleetDetail[]> {
  return (await readFleets(orgId, onlyArea)).map(({ tag: _tag, ...fleet }) => fleet);
}

/** Just the names and the small pictures: all a map needs to draw the tag of each plate. A picture with no small copy (uploaded before
 * there were any) falls back to the full one. */
export async function listFleetPictures(orgId: string, onlyArea?: string | null): Promise<FleetTag[]> {
  return (await readFleets(orgId, onlyArea)).map(({ name, tag, logo }) => ({ name, tag: tag ?? logo }));
}

/** Puts or removes the picture of a fleet; a fleet with nothing left to keep loses its row. */
export async function setFleetLogo(orgId: string, name: string, logo: string | null, tag: string | null = null): Promise<FleetSummary> {
  const fleet = clean(name);
  if (logo === null) {
    await db.delete(fleets).where(and(eq(fleets.orgId, orgId), eq(fleets.name, fleet)));
    return { name: fleet, logo: null };
  }
  await db
    .insert(fleets)
    .values({ orgId, name: fleet, logo, logoTag: tag })
    .onConflictDoUpdate({ target: [fleets.orgId, fleets.name], set: { logo, logoTag: tag } });
  return { name: fleet, logo };
}

export interface FleetAdminInput {
  name: string;
  email: string;
  password: string;
  language?: "es" | "it";
}

/**
 * The account that administers a fleet: limited to it (it sees only that fleet's vehicles) and a manager, so it can create the
 * sub-users of that fleet on its own. Same kind of account the team page makes, just made from the fleet.
 */
export async function createFleetAdmin(orgId: string, fleetName: string, input: FleetAdminInput) {
  return createTeamMember({
    orgId,
    name: input.name,
    email: input.email,
    password: input.password,
    role: "manager",
    allowedArea: clean(fleetName),
    language: input.language,
  });
}
