import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizationProducts, userProducts, users, type User } from "../db/schema/index.js";
import { hashPassword } from "./auth.service.js";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: User["role"];
  parentUserId: string | null;
  allowedArea: string | null;
  createdAt: Date;
  /** Only meaningful for role "viewer"/"manager" — owner/admin always see every product the org has. */
  productKeys: string[];
}

async function listOrgProductKeys(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ productKey: organizationProducts.productKey })
    .from(organizationProducts)
    .where(eq(organizationProducts.orgId, orgId));
  return rows.map((r) => r.productKey);
}

export async function getUserProductKeys(userId: string): Promise<string[]> {
  const rows = await db
    .select({ productKey: userProducts.productKey })
    .from(userProducts)
    .where(eq(userProducts.userId, userId));
  return rows.map((r) => r.productKey);
}

function toTeamMember(member: User, productKeys: string[]): TeamMember {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    parentUserId: member.parentUserId,
    allowedArea: member.allowedArea,
    createdAt: member.createdAt,
    productKeys,
  };
}

/**
 * owner/admin see the whole org; a "manager" sees only themself plus the sub-users
 * they created (parentUserId = their own id); anyone else (a plain viewer) sees only
 * themself.
 */
export async function listTeamMembers(
  orgId: string,
  requesterId: string,
  requesterRole: User["role"],
): Promise<TeamMember[]> {
  const scope =
    requesterRole === "owner" || requesterRole === "admin"
      ? eq(users.orgId, orgId)
      : requesterRole === "manager"
        ? and(eq(users.orgId, orgId), or(eq(users.id, requesterId), eq(users.parentUserId, requesterId)))
        : and(eq(users.orgId, orgId), eq(users.id, requesterId));

  const members = await db.select().from(users).where(scope);
  if (members.length === 0) return [];

  const memberIds = members.map((m) => m.id);
  const allUserProducts = await db
    .select({ userId: userProducts.userId, productKey: userProducts.productKey })
    .from(userProducts)
    .where(inArray(userProducts.userId, memberIds));

  const productsByUser = new Map<string, string[]>();
  for (const row of allUserProducts) {
    productsByUser.set(row.userId, [...(productsByUser.get(row.userId) ?? []), row.productKey]);
  }

  return members.map((member) => toTeamMember(member, productsByUser.get(member.id) ?? []));
}

export interface CreateTeamMemberInput {
  orgId: string;
  name: string;
  email: string;
  password: string;
  role: "admin" | "manager" | "viewer";
  /** Set when a "manager" is creating one of their own sub-users. */
  parentUserId?: string | null;
  /** Hard área restriction (e.g. "DHL"/"UNIVEX"), or null/undefined for unrestricted. */
  allowedArea?: string | null;
  /** Products to grant. Defaults to everything the org currently has (only meaningful
   * for role "viewer"/"manager" — owner/admin ignore this and always see everything). */
  productKeys?: string[];
}

export async function createTeamMember(input: CreateTeamMemberInput): Promise<TeamMember> {
  const passwordHash = await hashPassword(input.password);
  const grantedKeys = input.productKeys ?? (await listOrgProductKeys(input.orgId));

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        orgId: input.orgId,
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
        parentUserId: input.parentUserId ?? null,
        allowedArea: input.allowedArea ?? null,
      })
      .returning();

    if (grantedKeys.length > 0) {
      await tx.insert(userProducts).values(grantedKeys.map((productKey) => ({ userId: user!.id, productKey })));
    }

    return toTeamMember(user!, grantedKeys);
  });
}

export async function getTeamMember(orgId: string, userId: string): Promise<User | undefined> {
  const [member] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);
  return member;
}

export async function updateTeamMemberName(orgId: string, userId: string, name: string): Promise<User | undefined> {
  const [updated] = await db
    .update(users)
    .set({ name })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning();
  return updated;
}

export async function updateTeamMemberEmail(
  orgId: string,
  userId: string,
  email: string,
): Promise<User | undefined> {
  const [updated] = await db
    .update(users)
    .set({ email })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning();
  return updated;
}

export async function updateTeamMemberPassword(orgId: string, userId: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const [updated] = await db
    .update(users)
    .set({ passwordHash })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning({ id: users.id });
  return !!updated;
}

export async function updateTeamMemberArea(
  orgId: string,
  userId: string,
  allowedArea: string | null,
): Promise<User | undefined> {
  const [updated] = await db
    .update(users)
    .set({ allowedArea })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning();
  return updated;
}

export async function deleteTeamMember(orgId: string, userId: string): Promise<boolean> {
  const result = await db.delete(users).where(and(eq(users.id, userId), eq(users.orgId, orgId)));
  return (result.rowCount ?? 0) > 0;
}

export async function updateTeamMemberRole(
  orgId: string,
  userId: string,
  role: "admin" | "manager" | "viewer",
): Promise<User | undefined> {
  const [updated] = await db
    .update(users)
    .set({ role })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning();
  return updated;
}

export async function updateTeamMemberProducts(
  orgId: string,
  userId: string,
  productKeys: string[],
): Promise<boolean> {
  const [member] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);
  if (!member) return false;

  await db.transaction(async (tx) => {
    await tx.delete(userProducts).where(eq(userProducts.userId, userId));
    if (productKeys.length > 0) {
      await tx.insert(userProducts).values(productKeys.map((productKey) => ({ userId, productKey })));
    }
  });
  return true;
}
