import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizationProducts, userProducts, users, type User } from "../db/schema/index.js";
import { hashPassword } from "./auth.service.js";

export interface TeamMember {
  id: string;
  email: string;
  role: User["role"];
  createdAt: Date;
  /** Only meaningful for role "viewer" — owner/admin always see every product the org has. */
  productKeys: string[];
}

async function listOrgProductKeys(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ productKey: organizationProducts.productKey })
    .from(organizationProducts)
    .where(eq(organizationProducts.orgId, orgId));
  return rows.map((r) => r.productKey);
}

export async function listTeamMembers(orgId: string): Promise<TeamMember[]> {
  const members = await db.select().from(users).where(eq(users.orgId, orgId));
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

  return members.map((member) => ({
    id: member.id,
    email: member.email,
    role: member.role,
    createdAt: member.createdAt,
    productKeys: productsByUser.get(member.id) ?? [],
  }));
}

export interface CreateTeamMemberInput {
  orgId: string;
  email: string;
  password: string;
  role: "admin" | "viewer";
  /** Products to grant if role is "viewer". Defaults to everything the org currently has. */
  productKeys?: string[];
}

export async function createTeamMember(input: CreateTeamMemberInput): Promise<TeamMember> {
  const passwordHash = await hashPassword(input.password);
  const grantedKeys = input.productKeys ?? (await listOrgProductKeys(input.orgId));

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ orgId: input.orgId, email: input.email, passwordHash, role: input.role })
      .returning();

    if (grantedKeys.length > 0) {
      await tx.insert(userProducts).values(grantedKeys.map((productKey) => ({ userId: user!.id, productKey })));
    }

    return { id: user!.id, email: user!.email, role: user!.role, createdAt: user!.createdAt, productKeys: grantedKeys };
  });
}

export async function updateTeamMemberRole(
  orgId: string,
  userId: string,
  role: "admin" | "viewer",
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
