import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { qrLoginRequests } from "../db/schema/index.js";
import { describeDevice, type SessionClient } from "./userSession.service.js";

/** How long a QR on the computer's screen can be scanned. The screen replaces it with a fresh one before this runs out. */
export const QR_LOGIN_TTL_MS = 2 * 60_000;
/** Once a phone has said yes, the computer has this long to collect its session (it polls every couple of seconds). */
export const QR_CLAIM_WINDOW_MS = 60_000;

const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The text a QR carries is `<id>.<secret>`; anything else a camera might read is not ours. */
export function parseQrCode(code: string): { id: string; secret: string } | null {
  const [id, secret, extra] = code.trim().split(".");
  if (extra !== undefined || !id || !secret) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { id, secret };
}

type Row = typeof qrLoginRequests.$inferSelect;

/** The request a code points to, if the code is right. */
async function findByCode(code: string): Promise<Row | null> {
  const parsed = parseQrCode(code);
  if (!parsed) return null;
  const [row] = await db.select().from(qrLoginRequests).where(eq(qrLoginRequests.id, parsed.id)).limit(1);
  return row && sameHash(hash(parsed.secret), row.secretHash) ? row : null;
}

export async function startQrLogin(params: { userAgent?: string; ip?: string; now?: Date }): Promise<{ code: string; expiresAt: Date }> {
  const now = params.now ?? new Date();
  // Housekeeping: nothing here is worth keeping for long.
  await db.delete(qrLoginRequests).where(lt(qrLoginRequests.createdAt, new Date(now.getTime() - 3_600_000)));
  const secret = randomBytes(32).toString("base64url");
  const userAgent = (params.userAgent ?? "").slice(0, 300);
  const [row] = await db
    .insert(qrLoginRequests)
    .values({
      secretHash: hash(secret),
      userAgent,
      device: describeDevice(userAgent, "web"),
      ip: params.ip?.slice(0, 45) ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + QR_LOGIN_TTL_MS),
    })
    .returning();
  return { code: `${row!.id}.${secret}`, expiresAt: row!.expiresAt };
}

export interface QrRequestInfo {
  device: string;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** What the phone shows before asking "enter there?": which computer, from where. Null if the code is unknown, used or expired. */
export async function inspectQrLogin(code: string, now: Date = new Date()): Promise<QrRequestInfo | null> {
  const row = await findByCode(code);
  if (!row || row.status !== "pending" || row.expiresAt <= now) return null;
  return { device: row.device, ip: row.ip, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export type ApproveResult = "ok" | "invalid";

/** A signed-in phone says yes: the computer may take a session of this user. Only a request still pending and in time can be approved. */
export async function approveQrLogin(code: string, who: { userId: string; mfa: boolean }, now: Date = new Date()): Promise<ApproveResult> {
  const row = await findByCode(code);
  if (!row || row.expiresAt <= now) return "invalid";
  const updated = await db
    .update(qrLoginRequests)
    .set({ status: "approved", approvedUserId: who.userId, approvedMfa: who.mfa, approvedAt: now })
    .where(and(eq(qrLoginRequests.id, row.id), eq(qrLoginRequests.status, "pending")))
    .returning({ id: qrLoginRequests.id });
  return updated.length > 0 ? "ok" : "invalid";
}

export async function denyQrLogin(code: string, now: Date = new Date()): Promise<boolean> {
  const row = await findByCode(code);
  if (!row || row.expiresAt <= now) return false;
  const updated = await db
    .update(qrLoginRequests)
    .set({ status: "denied" })
    .where(and(eq(qrLoginRequests.id, row.id), eq(qrLoginRequests.status, "pending")))
    .returning({ id: qrLoginRequests.id });
  return updated.length > 0;
}

export type ClaimResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; userId: string; mfa: boolean; userAgent: string; ip: string | null; client: SessionClient };

/**
 * The computer asks whether a phone said yes. The approval is handed over exactly once (the row moves to "claimed" in the same
 * step), so a session is made for it a single time even if the poll is repeated.
 */
export async function claimQrLogin(code: string, now: Date = new Date()): Promise<ClaimResult> {
  const row = await findByCode(code);
  if (!row) return { status: "expired" };
  if (row.status === "denied") return { status: "denied" };
  if (row.status === "claimed") return { status: "expired" };
  if (row.status === "pending") return row.expiresAt <= now ? { status: "expired" } : { status: "pending" };

  // approved: collect it, if in time
  if (!row.approvedAt || now.getTime() - row.approvedAt.getTime() > QR_CLAIM_WINDOW_MS || !row.approvedUserId) return { status: "expired" };
  const taken = await db
    .update(qrLoginRequests)
    .set({ status: "claimed", claimedAt: now })
    .where(and(eq(qrLoginRequests.id, row.id), eq(qrLoginRequests.status, "approved")))
    .returning({ id: qrLoginRequests.id });
  if (taken.length === 0) return { status: "expired" };
  return { status: "approved", userId: row.approvedUserId, mfa: row.approvedMfa, userAgent: row.userAgent, ip: row.ip, client: "web" };
}
