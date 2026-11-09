import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSessions, type UserSession } from "../db/schema/index.js";

/** How long a login token lives. Short: it is what an attacker who copies it can use, and nobody notices the renewals. */
export const ACCESS_TOKEN_TTL = "15m";
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;

export type SessionClient = "web" | "app";

/**
 * How long a session may sit unused (`idleMs`, renewed each time it is used) and the most it may last at all (`absoluteMs`).
 * The Android apps are used from one's own phone, so they ask again after a month; a browser, which may be a shared computer, after a working day.
 */
export const SESSION_POLICY: Record<SessionClient, { idleMs: number; absoluteMs: number }> = {
  web: { idleMs: 8 * 3_600_000, absoluteMs: 24 * 3_600_000 },
  app: { idleMs: 30 * 86_400_000, absoluteMs: 90 * 86_400_000 },
};

/** A renewal that was sent twice (the answer never arrived) is answered again for this long instead of being taken for theft. */
export const REFRESH_GRACE_MS = 30_000;
const MAX_ACTIVE_SESSIONS_PER_USER = 20;

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string | null): boolean {
  if (!b) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** "<session id>.<secret>": the id finds the row, the secret proves it. */
export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret, extra] = token.split(".");
  if (extra !== undefined || !sessionId || !secret) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  return { sessionId, secret };
}

const newSecret = (): string => randomBytes(32).toString("base64url");

// --- Revoked sessions, remembered in memory for as long as a token of theirs could still be alive: that is what makes
// "sign out" take effect on the very next request instead of when the token runs out. (One API instance, as the rate limits.)
const revoked = new Map<string, number>();

function rememberRevoked(sessionIds: string[], now: number): void {
  for (const id of sessionIds) revoked.set(id, now + ACCESS_TOKEN_TTL_MS + 60_000);
  if (revoked.size > 1000) for (const [id, until] of revoked) if (until < now) revoked.delete(id);
}

export function isSessionRevoked(sessionId: string, now: number = Date.now()): boolean {
  const until = revoked.get(sessionId);
  if (until === undefined) return false;
  if (until < now) {
    revoked.delete(sessionId);
    return false;
  }
  return true;
}

/** For tests. */
export function forgetRevokedSessions(): void {
  revoked.clear();
}

/** A readable name for the list of sessions, from what the browser or the app says about itself. */
export function describeDevice(userAgent: string | undefined, client: SessionClient): string {
  const ua = userAgent ?? "";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iOS/i.test(ua)
      ? "iOS"
      : /Mac OS X|Macintosh/i.test(ua)
        ? "macOS"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  if (client === "app") {
    const app = /OneTrackApp/i.test(ua) ? "App OneTrack" : "App OneSystec";
    return os ? `${app} · ${os}` : app;
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navegador";
  return os ? `${browser} · ${os}` : browser;
}

export interface NewSession {
  session: UserSession;
  /** What the client keeps to renew its login token; shown once, never stored in the clear. */
  refreshToken: string;
}

function activeSessions(userId: string, now: Date) {
  return and(
    eq(userSessions.userId, userId),
    isNull(userSessions.revokedAt),
    gt(userSessions.expiresAt, now),
    gt(userSessions.absoluteExpiresAt, now),
  );
}

export async function createSession(params: {
  userId: string;
  client: SessionClient;
  mfa: boolean;
  userAgent?: string;
  ip?: string;
  now?: Date;
}): Promise<NewSession> {
  const now = params.now ?? new Date();
  const policy = SESSION_POLICY[params.client];
  const secret = newSecret();
  const [session] = await db
    .insert(userSessions)
    .values({
      userId: params.userId,
      refreshHash: hashSecret(secret),
      client: params.client,
      mfa: params.mfa,
      device: describeDevice(params.userAgent, params.client),
      ip: params.ip?.slice(0, 45) ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + policy.idleMs),
      absoluteExpiresAt: new Date(now.getTime() + policy.absoluteMs),
    })
    .returning();

  // Housekeeping for this user: old dead rows go, and no account keeps more than a few active devices (the oldest is signed out).
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  await db
    .delete(userSessions)
    .where(and(eq(userSessions.userId, params.userId), or(lt(userSessions.revokedAt, weekAgo), lt(userSessions.absoluteExpiresAt, weekAgo))));
  const active = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(activeSessions(params.userId, now))
    .orderBy(asc(userSessions.lastUsedAt));
  if (active.length > MAX_ACTIVE_SESSIONS_PER_USER) {
    await revokeSessionsById(
      active.slice(0, active.length - MAX_ACTIVE_SESSIONS_PER_USER).map((row) => row.id),
      now,
    );
  }

  return { session: session!, refreshToken: `${session!.id}.${secret}` };
}

export type RotateResult =
  | ({ outcome: "ok" } & NewSession)
  | { outcome: "invalid" }
  | { outcome: "expired" }
  /** The refresh secret was presented again after being replaced: someone has a copy. The whole session is revoked. */
  | { outcome: "reuse"; userId: string };

/** Spends a refresh token and hands back the next one (a new secret each time, so a copy taken earlier stops working). */
export async function rotateSession(refreshToken: string, now: Date = new Date()): Promise<RotateResult> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return { outcome: "invalid" };
  const [session] = await db.select().from(userSessions).where(eq(userSessions.id, parsed.sessionId)).limit(1);
  if (!session || session.revokedAt) return { outcome: "invalid" };

  const presented = hashSecret(parsed.secret);
  const isCurrent = sameHash(presented, session.refreshHash);
  const isPrevious = !isCurrent && sameHash(presented, session.previousHash);

  if (!isCurrent && !isPrevious) return { outcome: "invalid" };
  if (isPrevious) {
    const sinceRotation = session.rotatedAt ? now.getTime() - session.rotatedAt.getTime() : Infinity;
    if (sinceRotation > REFRESH_GRACE_MS) {
      await revokeSessionsById([session.id], now);
      return { outcome: "reuse", userId: session.userId };
    }
  }
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return { outcome: "expired" };

  const policy = SESSION_POLICY[session.client === "app" ? "app" : "web"];
  const secret = newSecret();
  const idleEnd = new Date(Math.min(now.getTime() + policy.idleMs, session.absoluteExpiresAt.getTime()));
  const [updated] = await db
    .update(userSessions)
    .set({
      refreshHash: hashSecret(secret),
      // Within the grace period the one just used stays "previous"; otherwise the one being replaced becomes it.
      previousHash: isPrevious ? session.previousHash : session.refreshHash,
      rotatedAt: now,
      lastUsedAt: now,
      expiresAt: idleEnd,
    })
    .where(and(eq(userSessions.id, session.id), isNull(userSessions.revokedAt)))
    .returning();
  if (!updated) return { outcome: "invalid" };
  return { outcome: "ok", session: updated, refreshToken: `${updated.id}.${secret}` };
}

export async function revokeSessionsById(sessionIds: string[], now: Date = new Date()): Promise<void> {
  if (sessionIds.length === 0) return;
  await db.update(userSessions).set({ revokedAt: now }).where(and(inArray(userSessions.id, sessionIds), isNull(userSessions.revokedAt)));
  rememberRevoked(sessionIds, now.getTime());
}

/** Ends one session of this user (their own list of devices). False if it isn't theirs or is already over. */
export async function revokeUserSession(userId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  if (row) rememberRevoked([row.id], now.getTime());
  return !!row;
}

/** Ends every session of the user, except `exceptId` (the one asking, when it signs out the others). Returns how many. */
export async function revokeAllUserSessions(userId: string, exceptId?: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: now })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), exceptId ? ne(userSessions.id, exceptId) : undefined))
    .returning({ id: userSessions.id });
  rememberRevoked(
    rows.map((row) => row.id),
    now.getTime(),
  );
  return rows.length;
}

/** Signs out the session a refresh token belongs to (when the login token has already run out and only the refresh one is left). */
export async function revokeByRefreshToken(refreshToken: string): Promise<void> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;
  const [session] = await db.select().from(userSessions).where(eq(userSessions.id, parsed.sessionId)).limit(1);
  if (!session) return;
  const presented = hashSecret(parsed.secret);
  if (sameHash(presented, session.refreshHash) || sameHash(presented, session.previousHash)) await revokeSessionsById([session.id]);
}

export interface SessionSummary {
  id: string;
  device: string;
  client: SessionClient;
  ip: string | null;
  mfa: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  current: boolean;
}

export async function listUserSessions(userId: string, currentSessionId?: string, now: Date = new Date()): Promise<SessionSummary[]> {
  const rows = await db.select().from(userSessions).where(activeSessions(userId, now)).orderBy(desc(userSessions.lastUsedAt));
  return rows.map((row) => ({
    id: row.id,
    device: row.device,
    client: row.client === "app" ? "app" : "web",
    ip: row.ip,
    mfa: row.mfa,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    current: row.id === currentSessionId,
  }));
}

/** One session by id (null if it doesn't exist), for the rules that depend on how a session was opened. */
export async function getSession(sessionId: string): Promise<UserSession | null> {
  const [row] = await db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1);
  return row ?? null;
}
