import { randomInt } from "node:crypto";
import { and, eq, isNull, or, lt, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { userRecoveryCodes, users, type User } from "../db/schema/index.js";
import { decryptSecret, encryptSecret } from "./secretBox.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";
import { isEmailCodeLoginAvailable } from "./emailCode.service.js";
import { hashSecret } from "./userSession.service.js";

export const TOTP_ISSUER = "OneSystec";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: they get read out and copied by hand

/** Owners and admins hold an organization's account (and OneSystec's people are admins): they can't sign in without the second step. */
export function isTotpRequired(role: User["role"]): boolean {
  return env.ADMIN_TOTP_REQUIRED && (role === "owner" || role === "admin");
}

/**
 * Whether this role must use the authenticator app itself. Only when there is no email to send codes to: with email set up, the
 * code by email satisfies the second step and the app is optional (an extra way, and the only one that works without the mailbox).
 */
export function isAuthenticatorRequired(role: User["role"]): boolean {
  return isTotpRequired(role) && !isEmailCodeLoginAvailable();
}

export interface MfaStatus {
  /** The authenticator is set up and offered at every sign-in. */
  enabled: boolean;
  /** This account's role may not be without the authenticator (no email codes available to stand in for it). */
  required: boolean;
  /** Every sign-in of this account asks for a second step. */
  secondStepRequired: boolean;
  /** Codes are sent by email: that is the second step unless the authenticator is used instead. */
  emailCodes: boolean;
  recoveryCodesLeft: number;
}

export async function getMfaStatus(user: Pick<User, "id" | "role" | "totpEnabledAt">): Promise<MfaStatus> {
  const [row] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, user.id), isNull(userRecoveryCodes.usedAt)));
  return {
    enabled: !!user.totpEnabledAt,
    required: isAuthenticatorRequired(user.role),
    secondStepRequired: isTotpRequired(user.role) || !!user.totpEnabledAt,
    emailCodes: isEmailCodeLoginAvailable(),
    recoveryCodesLeft: row?.left ?? 0,
  };
}

async function loadUser(userId: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user;
}

/** Starts (or restarts, while it isn't confirmed yet) the setup: a fresh secret, shown once as text and as the QR's address. */
export async function startTotpSetup(userId: string): Promise<{ secret: string; uri: string } | null> {
  const user = await loadUser(userId);
  if (!user || user.totpEnabledAt) return null;
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(secret), totpLastStep: null }).where(eq(users.id, userId));
  return { secret, uri: otpauthUri({ secret, account: user.email, issuer: TOTP_ISSUER }) };
}

/** Checks a code against a stored secret and, if right, records the step so that it can't be used again. */
async function checkCode(user: User, code: string, now: number): Promise<boolean> {
  if (!user.totpSecretEnc) return false;
  const step = verifyTotp(decryptSecret(user.totpSecretEnc), code, now, user.totpLastStep);
  if (step === null) return false;
  // Conditional update: two requests with the same code at once can't both pass.
  const updated = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id });
  return updated.length > 0;
}

/** Ten new single-use codes (the old ones stop working). They are returned once; only their hashes are kept. */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await db.transaction(async (tx) => {
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.insert(userRecoveryCodes).values(codes.map((code) => ({ userId, codeHash: hashSecret(normalizeRecoveryCode(code)) })));
  });
  return codes;
}

const normalizeRecoveryCode = (code: string): string => code.replace(/[^a-z0-9]/gi, "").toUpperCase();

/** The user typed the first code from their app: the authenticator is on, and the recovery codes are handed over. */
export async function confirmTotpSetup(userId: string, code: string, now: number = Date.now()): Promise<{ recoveryCodes: string[] } | null> {
  const user = await loadUser(userId);
  if (!user || user.totpEnabledAt || !user.totpSecretEnc) return null;
  if (!(await checkCode(user, code, now))) return null;
  await db.update(users).set({ totpEnabledAt: new Date(now) }).where(eq(users.id, userId));
  return { recoveryCodes: await generateRecoveryCodes(userId) };
}

export type SecondFactor = "totp" | "recovery";

/** The second step of a sign-in: a code from the app, or one of the recovery codes (which is spent). */
export async function verifySecondFactor(userId: string, input: { code?: string; recoveryCode?: string }, now: number = Date.now()): Promise<SecondFactor | null> {
  const user = await loadUser(userId);
  if (!user?.totpEnabledAt) return null;
  if (input.code) return (await checkCode(user, input.code, now)) ? "totp" : null;
  if (input.recoveryCode) {
    const normalized = normalizeRecoveryCode(input.recoveryCode);
    if (normalized.length !== 10) return null;
    const spent = await db
      .update(userRecoveryCodes)
      .set({ usedAt: new Date(now) })
      .where(and(eq(userRecoveryCodes.userId, userId), eq(userRecoveryCodes.codeHash, hashSecret(normalized)), isNull(userRecoveryCodes.usedAt)))
      .returning({ id: userRecoveryCodes.id });
    return spent.length > 0 ? "recovery" : null;
  }
  return null;
}

/** Turns the authenticator off (the user chose it, or OneSystec/an admin reset it after a lost phone). */
export async function disableTotp(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, userId));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  });
}
