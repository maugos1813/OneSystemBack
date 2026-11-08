import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { SessionClient } from "./userSession.service.js";

/**
 * The few minutes between "password accepted" and "second step passed". It proves the password was right for this user, and
 * nothing else: it is signed with a key of its own (derived from JWT_SECRET), so it can never be taken for a login token.
 *  - "mfa": the account has an authenticator; the code is what's missing.
 *  - "mfa-setup": the account must have one (an admin) and doesn't yet; setting it up is what's missing.
 */
export type MfaPurpose = "mfa" | "mfa-setup";

const TTL_SECONDS = 10 * 60;
const key = (): string => createHash("sha256").update(`mfa-token:${env.JWT_SECRET}`).digest("hex");

export function signMfaToken(params: { userId: string; purpose: MfaPurpose; client: SessionClient }): string {
  return jwt.sign({ sub: params.userId, purpose: params.purpose, client: params.client }, key(), { algorithm: "HS256", expiresIn: TTL_SECONDS });
}

export function verifyMfaToken(token: string, purpose: MfaPurpose): { userId: string; client: SessionClient } | null {
  try {
    const payload = jwt.verify(token, key(), { algorithms: ["HS256"] }) as { sub?: unknown; purpose?: unknown; client?: unknown };
    if (payload.purpose !== purpose || typeof payload.sub !== "string") return null;
    return { userId: payload.sub, client: payload.client === "app" ? "app" : "web" };
  } catch {
    return null;
  }
}
