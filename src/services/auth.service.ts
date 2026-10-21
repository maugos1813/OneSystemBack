import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations, users, type User } from "../db/schema/index.js";
import { resolveModules, type ModuleKey } from "./modules.js";

export interface CurrentUser {
  userId: string;
  name: string;
  email: string;
  role: User["role"];
  allowedArea: string | null;
  orgId: string;
  orgName: string;
  /** The organization's logo as a data URL, or null. */
  orgLogo: string | null;
  /** This user's own logo (a client such as DHL), or null; when set it takes the place of the organization's. */
  userLogo: string | null;
  /** The OneTrack sections this user may use (everything for owner/admin). */
  modules: ModuleKey[];
}

export async function getCurrentUser(userId: string): Promise<CurrentUser | undefined> {
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      allowedArea: users.allowedArea,
      orgId: organizations.id,
      orgName: organizations.name,
      orgLogo: organizations.logo,
      userLogo: users.logo,
      storedModules: users.modules,
    })
    .from(users)
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return undefined;
  const { storedModules, ...rest } = row;
  return { ...rest, modules: resolveModules(row.role, storedModules) };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export interface RegisterOrgInput {
  orgName: string;
  email: string;
  password: string;
  logo?: string;
}

/** Creates a brand new organization together with its first user (the "owner"). */
export async function registerOrganizationWithOwner({
  orgName,
  email,
  password,
  logo,
}: RegisterOrgInput): Promise<{ orgId: string; user: User }> {
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: orgName, logo: logo ?? null }).returning();
    const [user] = await tx
      .insert(users)
      .values({ orgId: org!.id, email, passwordHash, role: "owner" })
      .returning();
    return { orgId: org!.id, user: user! };
  });
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  const valid = await verifyPassword(user.passwordHash, password);
  return valid ? user : null;
}
