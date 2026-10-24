import { eq, inArray } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { pushTokens } from "../db/schema/index.js";

export interface PushMessage {
  title: string;
  body: string;
  /** Extra data the app receives with the notification (e.g. where to go when it is tapped). */
  data?: Record<string, string>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let account: ServiceAccount | null | undefined;
let auth: GoogleAuth | null = null;

/** The Firebase credential, or null when push isn't configured (or the variable doesn't hold a usable key). */
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  account = null;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return account;
  try {
    const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Partial<ServiceAccount>;
    if (parsed.project_id && parsed.client_email && parsed.private_key) account = parsed as ServiceAccount;
    else logger.warn("FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email or private_key; push is off");
  } catch {
    logger.warn("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON; push is off");
  }
  return account;
}

export function isPushConfigured(): boolean {
  return serviceAccount() !== null;
}

async function accessToken(creds: ServiceAccount): Promise<string> {
  auth ??= new GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("no access token");
  return token;
}

/** FCM answers these when the phone uninstalled the app or the token expired: the token is dead and must be forgotten. */
function isDeadToken(status: number, body: unknown): boolean {
  if (status === 404) return true;
  const detail = JSON.stringify(body ?? "");
  return status === 400 && /UNREGISTERED|INVALID_ARGUMENT.*registration token|registration token is not a valid/i.test(detail);
}

async function sendOne(creds: ServiceAccount, bearer: string, token: string, message: PushMessage): Promise<"sent" | "dead" | "failed"> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: message.title, body: message.body },
        data: message.data ?? {},
        android: { priority: "HIGH", notification: { channel_id: "alerts", sound: "default" } },
      },
    }),
  });
  if (res.ok) return "sent";
  const body = await res.json().catch(() => null);
  if (isDeadToken(res.status, body)) return "dead";
  logger.warn({ status: res.status, body }, "FCM rejected a notification");
  return "failed";
}

/**
 * Sends a notification to every phone of these users. Never throws: a failed push must not break the alert run. Tokens
 * FCM says are dead are deleted. Returns how many notifications were accepted.
 */
export async function sendPushToUsers(userIds: readonly string[], message: PushMessage): Promise<number> {
  const creds = serviceAccount();
  if (!creds || userIds.length === 0) return 0;
  try {
    const rows = await db.select().from(pushTokens).where(inArray(pushTokens.userId, [...userIds]));
    if (rows.length === 0) return 0;
    const bearer = await accessToken(creds);
    let sent = 0;
    const dead: string[] = [];
    for (const row of rows) {
      const result = await sendOne(creds, bearer, row.token, message).catch(() => "failed" as const);
      if (result === "sent") sent += 1;
      else if (result === "dead") dead.push(row.id);
    }
    if (dead.length > 0) await db.delete(pushTokens).where(inArray(pushTokens.id, dead));
    return sent;
  } catch (err) {
    logger.error({ err }, "Sending push notifications failed");
    return 0;
  }
}

/** Remembers a phone for a user (moving it from whoever signed in on it before). */
export async function saveToken(userId: string, orgId: string, token: string, platform: string, now: Date = new Date()): Promise<void> {
  await db
    .insert(pushTokens)
    .values({ userId, orgId, token, platform, lastSeenAt: now })
    .onConflictDoUpdate({ target: pushTokens.token, set: { userId, orgId, platform, lastSeenAt: now } });
}

/** Forgets a phone — only if it belongs to this user, so nobody can unregister someone else's. */
export async function removeToken(userId: string, token: string): Promise<void> {
  const owned = await db.select({ id: pushTokens.id, userId: pushTokens.userId }).from(pushTokens).where(eq(pushTokens.token, token)).limit(1);
  if (owned[0] && owned[0].userId === userId) await db.delete(pushTokens).where(eq(pushTokens.id, owned[0].id));
}

/** The text of the notification for a run's new alerts: how many, and the first few. */
export function alertPushMessage(orgName: string, messages: readonly string[]): PushMessage {
  const shown = messages.slice(0, 3).join("\n");
  const rest = messages.length - 3;
  return {
    title: messages.length === 1 ? "OneTrack · 1 alerta nueva" : `OneTrack · ${messages.length} alertas nuevas`,
    body: rest > 0 ? `${shown}\n+${rest} más` : shown,
    data: { url: "/alertas", org: orgName },
  };
}
