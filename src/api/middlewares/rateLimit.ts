import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";

/** Fixed-window counter per key. In-memory on purpose: this API runs as a single
 * instance, and a shared store would be one more paid service for the same protection. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
      this.evictExpired(now);
    }
    window.count++;

    return {
      allowed: window.count <= this.limit,
      remaining: Math.max(0, this.limit - window.count),
      retryAfterSec: Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000)),
    };
  }

  private evictExpired(now: number): void {
    if (this.windows.size < 500) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}

const apiKeyLimiter = new FixedWindowLimiter(env.PUBLIC_API_RATE_LIMIT_PER_MIN, 60_000);

/** Runs after requireApiKey, so `request.apiKeyId` is always set. */
export async function rateLimitApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = apiKeyLimiter.hit(request.apiKeyId!);
  void reply.header("X-RateLimit-Limit", env.PUBLIC_API_RATE_LIMIT_PER_MIN);
  void reply.header("X-RateLimit-Remaining", result.remaining);
  if (!result.allowed) {
    void reply.header("Retry-After", result.retryAfterSec);
    await reply.code(429).send({ error: "Rate limit exceeded", retryAfterSeconds: result.retryAfterSec });
  }
}
