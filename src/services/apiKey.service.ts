import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeys, type ApiKey } from "../db/schema/index.js";

const KEY_PREFIX = "osk_live_";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface CreatedApiKey {
  record: ApiKey;
  /** The plaintext key — only ever available here, right after creation. */
  plaintextKey: string;
}

export async function createApiKey(orgId: string, name: string): Promise<CreatedApiKey> {
  const plaintextKey = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  const [record] = await db
    .insert(apiKeys)
    .values({
      orgId,
      name,
      keyHash: hashKey(plaintextKey),
      keyPrefix: plaintextKey.slice(0, 16),
    })
    .returning();
  return { record: record!, plaintextKey };
}

export async function listApiKeys(orgId: string): Promise<ApiKey[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId));
}

export async function revokeApiKey(orgId: string, id: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
  return (result.rowCount ?? 0) > 0;
}

export interface AuthenticatedApiKey {
  orgId: string;
}

/** Looks up an active (non-revoked) key by its plaintext value and touches lastUsedAt.
 * Returns null if the key doesn't exist or was revoked. */
export async function authenticateApiKey(plaintextKey: string): Promise<AuthenticatedApiKey | null> {
  const [record] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(plaintextKey)), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!record) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, record.id));
  return { orgId: record.orgId };
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX);
}
