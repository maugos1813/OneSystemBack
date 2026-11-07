import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { fleets, users } from "../db/schema/index.js";

/** What a map needs of a fleet: its name and the small picture that opens each plate. */
export interface FleetTag {
  name: string;
  tag: string | null;
}

const clean = (name: string): string => name.trim();

/**
 * The fleets of an organization and the picture of each, for the tag that opens every plate on the map. A fleet is an account of the team
 * limited to it (its `allowedArea` is the fleet's name), so the picture is that account's photo: the small copy made when the photo was
 * uploaded where there is one, the full photo otherwise. `onlyArea` narrows the answer to one fleet (an account limited to its own).
 */
export async function listFleetPictures(orgId: string, onlyArea?: string | null): Promise<FleetTag[]> {
  const [rows, accounts] = await Promise.all([
    db.select().from(fleets).where(eq(fleets.orgId, orgId)),
    db
      .select({ area: users.allowedArea, logo: users.logo })
      .from(users)
      .where(and(eq(users.orgId, orgId), isNotNull(users.allowedArea), ne(users.allowedArea, ""))),
  ]);

  const byName = new Map<string, string | null>();
  for (const row of rows) byName.set(clean(row.name), row.logoTag ?? row.logo);
  for (const account of accounts) {
    const name = clean(account.area ?? "");
    if (name && !byName.get(name)) byName.set(name, account.logo ?? byName.get(name) ?? null);
  }

  const all = [...byName].map(([name, tag]) => ({ name, tag })).sort((a, b) => a.name.localeCompare(b.name));
  return onlyArea ? all.filter((fleet) => fleet.name === clean(onlyArea)) : all;
}

/**
 * Keeps the picture of a fleet, which is the photo of its account: the photo itself and the small copy for the map. A fleet with
 * nothing left to keep loses its row, and the map then falls back to whatever photo its accounts have.
 */
export async function setFleetLogo(orgId: string, name: string, logo: string | null, tag: string | null = null): Promise<void> {
  const fleet = clean(name);
  if (logo === null) {
    await db.delete(fleets).where(and(eq(fleets.orgId, orgId), eq(fleets.name, fleet)));
    return;
  }
  await db
    .insert(fleets)
    .values({ orgId, name: fleet, logo, logoTag: tag })
    .onConflictDoUpdate({ target: [fleets.orgId, fleets.name], set: { logo, logoTag: tag } });
}
