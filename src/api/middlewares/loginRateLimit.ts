import type { FastifyReply, FastifyRequest } from "fastify";
import { FixedWindowLimiter } from "./rateLimit.js";

/**
 * Brake on guessing passwords. Every attempt counts (right or wrong), so a limit that is high for a person is far too low for a script:
 *  - per address + email: someone hammering one account from one place;
 *  - per address: someone trying many accounts from one place.
 * In memory like the API-key limiter (one API instance). Windows are fixed, so a lock lasts at most until its window ends.
 */
const WINDOW_MS = 15 * 60_000;
export const LOGIN_LIMITS = { perAddressAndEmail: 10, perAddress: 60 } as const;
/** Opening organizations is open to anyone, so it gets its own, much tighter, limit per address. */

let byAddressAndEmail = new FixedWindowLimiter(LOGIN_LIMITS.perAddressAndEmail, WINDOW_MS);
let byAddress = new FixedWindowLimiter(LOGIN_LIMITS.perAddress, WINDOW_MS);

/** For tests: forget every count. */
export function resetLoginLimits(): void {
  byAddressAndEmail = new FixedWindowLimiter(LOGIN_LIMITS.perAddressAndEmail, WINDOW_MS);
  byAddress = new FixedWindowLimiter(LOGIN_LIMITS.perAddress, WINDOW_MS);
}

async function refuse(reply: FastifyReply, retryAfterSec: number): Promise<void> {
  void reply.header("Retry-After", retryAfterSec);
  await reply.code(429).send({ error: "Too many attempts. Try again later.", retryAfterSeconds: retryAfterSec });
}

/**
 * The client's own address. Railway's edge puts it in X-Real-IP (the socket only shows one of the edge's addresses, a different one
 * from request to request); anywhere else (tests, local) there is no such header and the socket address is the client's.
 */
export function clientAddress(request: FastifyRequest): string {
  const real = request.headers["x-real-ip"];
  return typeof real === "string" && real.length > 0 && real.length <= 45 ? real.trim() : request.ip;
}

const emailOf = (request: FastifyRequest): string => {
  const email = (request.body as { email?: unknown } | null)?.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";
};

/** preHandler for POST /auth/login (the body is parsed by then). */
export async function rateLimitLogin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const address = clientAddress(request);
  const email = emailOf(request);
  const results = [byAddress.hit(address), byAddressAndEmail.hit(`${address}|${email}`)];
  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length > 0) {
    request.log.warn({ address }, "Login attempts blocked: too many from this address");
    await refuse(reply, Math.max(...blocked.map((r) => r.retryAfterSec)));
  }
}

/**
 * Brake on guessing the second step. Six digits are a million possibilities: ten tries per account every 15 minutes (whoever is
 * trying and from where) make guessing hopeless, and a stray run of typos by the real person only costs a short wait.
 */
export const SECOND_FACTOR_LIMITS = { perUser: 10, perAddress: 40 } as const;
let secondFactorByUser = new FixedWindowLimiter(SECOND_FACTOR_LIMITS.perUser, WINDOW_MS);
let secondFactorByAddress = new FixedWindowLimiter(SECOND_FACTOR_LIMITS.perAddress, WINDOW_MS);

export function resetSecondFactorLimits(): void {
  secondFactorByUser = new FixedWindowLimiter(SECOND_FACTOR_LIMITS.perUser, WINDOW_MS);
  secondFactorByAddress = new FixedWindowLimiter(SECOND_FACTOR_LIMITS.perAddress, WINDOW_MS);
}

/** Counts one attempt; when over the limit it answers 429 and returns true (the caller stops there). */
export async function rateLimitSecondFactor(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<boolean> {
  const results = [secondFactorByUser.hit(userId), secondFactorByAddress.hit(clientAddress(request))];
  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length === 0) return false;
  request.log.warn({ userId }, "Second-step attempts blocked: too many");
  await refuse(reply, Math.max(...blocked.map((r) => r.retryAfterSec)));
  return true;
}

/**
 * "Enter with the phone": starting a QR is public (the login screen asks for one every couple of minutes), polling it is a request
 * every second or two, and approving is for people already signed in. Generous for a person, hopeless for a script.
 */
export const QR_LIMITS = { startPerAddress: 20, pollPerAddress: 240, actionPerUser: 30 } as const;
let qrStartByAddress = new FixedWindowLimiter(QR_LIMITS.startPerAddress, 60_000);
let qrPollByAddress = new FixedWindowLimiter(QR_LIMITS.pollPerAddress, 60_000);
let qrActionByUser = new FixedWindowLimiter(QR_LIMITS.actionPerUser, WINDOW_MS);

export function resetQrLimits(): void {
  qrStartByAddress = new FixedWindowLimiter(QR_LIMITS.startPerAddress, 60_000);
  qrPollByAddress = new FixedWindowLimiter(QR_LIMITS.pollPerAddress, 60_000);
  qrActionByUser = new FixedWindowLimiter(QR_LIMITS.actionPerUser, WINDOW_MS);
}

export async function rateLimitQrStart(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = qrStartByAddress.hit(clientAddress(request));
  if (!result.allowed) await refuse(reply, result.retryAfterSec);
}

export async function rateLimitQrPoll(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = qrPollByAddress.hit(clientAddress(request));
  if (!result.allowed) await refuse(reply, result.retryAfterSec);
}

/** Counts one scan/approval by a signed-in user; over the limit it answers 429 and returns true. */
export async function rateLimitQrAction(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<boolean> {
  const result = qrActionByUser.hit(userId);
  if (result.allowed) return false;
  await refuse(reply, result.retryAfterSec);
  return true;
}
