import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { userEmailCodes } from "../db/schema/index.js";
import { canEmailLoginCodes, sendLoginCodeEmail } from "./email.service.js";
import type { Language } from "./i18n.js";

/**
 * The second step for someone signing in from a phone: a 6-digit code sent to the email of the account. (On a computer the
 * authenticator app and its QR are used; a phone can't scan a QR shown on its own screen.) The code lives ten minutes, works once
 * and survives five wrong tries.
 */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_COOLDOWN_MS = 30_000;
export const EMAIL_CODE_MAX_PER_HOUR = 5;

/** Whether phone sign-ins can use email codes right now. When not, they keep using the authenticator app. */
export const isEmailCodeLoginAvailable = (): boolean => canEmailLoginCodes();

const hashCode = (userId: string, code: string): string =>
  createHmac("sha256", `email-code:${env.JWT_SECRET}`).update(`${userId}:${code}`).digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** "ana.perez@gmail.com" → "a•••@gmail.com": enough for the person to know which mailbox to open. */
export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}

export type IssueResult =
  | { outcome: "sent" }
  /** A code went out moments ago and is still good: not sent again (a double tap, or logging in twice). */
  | { outcome: "recent"; retryAfterSec: number }
  | { outcome: "limit" }
  | { outcome: "failed" };

/** Sends a new code (the older ones stop working). */
export async function issueEmailCode(user: { id: string; email: string; language: Language }, now: Date = new Date()): Promise<IssueResult> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const recent = await db
    .select({ createdAt: userEmailCodes.createdAt })
    .from(userEmailCodes)
    .where(and(eq(userEmailCodes.userId, user.id), gt(userEmailCodes.createdAt, hourAgo)))
    .orderBy(desc(userEmailCodes.createdAt));
  if (recent.length >= EMAIL_CODE_MAX_PER_HOUR) return { outcome: "limit" };
  const last = recent[0];
  if (last && now.getTime() - last.createdAt.getTime() < EMAIL_CODE_COOLDOWN_MS) {
    return { outcome: "recent", retryAfterSec: Math.ceil((EMAIL_CODE_COOLDOWN_MS - (now.getTime() - last.createdAt.getTime())) / 1000) };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.update(userEmailCodes).set({ consumedAt: now }).where(and(eq(userEmailCodes.userId, user.id), isNull(userEmailCodes.consumedAt)));
  const [row] = await db
    .insert(userEmailCodes)
    .values({ userId: user.id, codeHash: hashCode(user.id, code), createdAt: now, expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS) })
    .returning({ id: userEmailCodes.id });

  if (!(await sendLoginCodeEmail(user.email, code, user.language))) {
    // Never delivered: it must not count against the hourly limit nor stay valid.
    await db.delete(userEmailCodes).where(eq(userEmailCodes.id, row!.id));
    return { outcome: "failed" };
  }
  return { outcome: "sent" };
}

/** Whether this is the code last sent to the user (still valid, with tries left). A right code is spent. */
export async function verifyEmailCode(userId: string, code: string, now: Date = new Date()): Promise<boolean> {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return false;
  const [current] = await db
    .select()
    .from(userEmailCodes)
    .where(and(eq(userEmailCodes.userId, userId), isNull(userEmailCodes.consumedAt), gt(userEmailCodes.expiresAt, now)))
    .orderBy(desc(userEmailCodes.createdAt))
    .limit(1);
  if (!current) return false;

  // The try is counted before it is compared, so parallel guesses can't exceed the limit.
  const [counted] = await db
    .update(userEmailCodes)
    .set({ attempts: sql`${userEmailCodes.attempts} + 1` })
    .where(and(eq(userEmailCodes.id, current.id), isNull(userEmailCodes.consumedAt), sql`${userEmailCodes.attempts} < ${EMAIL_CODE_MAX_ATTEMPTS}`))
    .returning({ attempts: userEmailCodes.attempts });
  if (!counted) return false;

  if (!sameHash(hashCode(userId, typed), current.codeHash)) {
    if (counted.attempts >= EMAIL_CODE_MAX_ATTEMPTS) await db.update(userEmailCodes).set({ consumedAt: now }).where(eq(userEmailCodes.id, current.id));
    return false;
  }
  const spent = await db
    .update(userEmailCodes)
    .set({ consumedAt: now })
    .where(and(eq(userEmailCodes.id, current.id), isNull(userEmailCodes.consumedAt)))
    .returning({ id: userEmailCodes.id });
  return spent.length > 0;
}
