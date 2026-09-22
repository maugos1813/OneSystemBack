import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations, users, type User } from "../db/schema/index.js";

export interface CurrentUser {
  userId: string;
  email: string;
  role: User["role"];
  orgId: string;
  orgName: string;
}

export async function getCurrentUser(userId: string): Promise<CurrentUser | undefined> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      role: users.role,
      orgId: organizations.id,
      orgName: organizations.name,
    })
    .from(users)
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row;
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
}

/** Creates a brand new organization together with its first user (the "owner"). */
export async function registerOrganizationWithOwner({
  orgName,
  email,
  password,
}: RegisterOrgInput): Promise<{ orgId: string; user: User }> {
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: orgName }).returning();
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
