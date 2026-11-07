import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations, users } from "../db/schema/index.js";
import { resolveModules, type ModuleKey } from "./modules.js";

/** The sections the user may use right now, read from the database so a change by the admin (or by OneSystec) applies at once. */
export async function getUserModules(userId: string): Promise<ModuleKey[]> {
  const [row] = await db
    .select({ role: users.role, modules: users.modules, orgModules: organizations.modules })
    .from(users)
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(eq(users.id, userId))
    .limit(1);
  return row ? resolveModules(row.role, row.modules, row.orgModules) : [];
}
