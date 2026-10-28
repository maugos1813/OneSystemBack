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
export const REGISTER_LIMIT_PER_HOUR = 5;

let byAddressAndEmail = new FixedWindowLimiter(LOGIN_LIMITS.perAddressAndEmail, WINDOW_MS);
let byAddress = new FixedWindowLimiter(LOGIN_LIMITS.perAddress, WINDOW_MS);
let registrations = new FixedWindowLimiter(REGISTER_LIMIT_PER_HOUR, 60 * 60_000);

/** For tests: forget every count. */
export function resetLoginLimits(): void {
  byAddressAndEmail = new FixedWindowLimiter(LOGIN_LIMITS.perAddressAndEmail, WINDOW_MS);
  byAddress = new FixedWindowLimiter(LOGIN_LIMITS.perAddress, WINDOW_MS);
  registrations = new FixedWindowLimiter(REGISTER_LIMIT_PER_HOUR, 60 * 60_000);
}

async function refuse(reply: FastifyReply, retryAfterSec: number): Promise<void> {
  void reply.header("Retry-After", retryAfterSec);
  await reply.code(429).send({ error: "Too many attempts. Try again later.", retryAfterSeconds: retryAfterSec });
}

const emailOf = (request: FastifyRequest): string => {
  const email = (request.body as { email?: unknown } | null)?.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";
};

/** preHandler for POST /auth/login (the body is parsed by then). */
export async function rateLimitLogin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const address = request.ip;
  const email = emailOf(request);
  const results = [byAddress.hit(address), byAddressAndEmail.hit(`${address}|${email}`)];
  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length > 0) await refuse(reply, Math.max(...blocked.map((r) => r.retryAfterSec)));
}

/** preHandler for POST /auth/register. */
export async function rateLimitRegister(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = registrations.hit(request.ip);
  if (!result.allowed) await refuse(reply, result.retryAfterSec);
}
