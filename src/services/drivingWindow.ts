import { z } from "zod";
import { DEFAULT_SPEED_LIMIT_KMH } from "./drivingStyle.service.js";

/**
 * The time window of a public driving-style request: either the last `days` days ending now
 * (the original behaviour) or an exact `from`..`to` stretch (e.g. one driver's shift).
 *
 * Precedence: when `from` and `to` are sent, they are used and `days` is IGNORED (even if it
 * is invalid), so a caller can't end up with two competing windows.
 */

export const DEFAULT_DAYS = 7;
export const MAX_WINDOW_DAYS = 31;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const isoDateTime = (name: string) =>
  z
    .string()
    .datetime({ offset: true, message: `\`${name}\` must be an ISO 8601 date-time, e.g. 2026-10-09T08:00:00Z` })
    .transform((value) => new Date(value));

const speedLimitField = z.coerce.number().min(10).max(300).default(DEFAULT_SPEED_LIMIT_KMH);

/** Exact-window requests. */
const windowQuery = z.object({
  from: isoDateTime("from").optional(),
  to: isoDateTime("to").optional(),
  speedLimit: speedLimitField,
});

/** The original query (`days` + `speedLimit`), kept verbatim — including the shape of its
 * validation errors — so requests that don't use from/to behave exactly as before. */
const legacyQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_WINDOW_DAYS).default(DEFAULT_DAYS),
  speedLimit: speedLimitField,
});

export interface DrivingWindow {
  speedLimitKmh: number;
  /** Always set. */
  days: number;
  /** Set together, only for an exact window (already validated, `to` clamped to now). */
  from?: Date;
  to?: Date;
}

/** `error` is a plain message for from/to problems, and the original zod error object for a
 * bad `days`/`speedLimit` (unchanged from before from/to existed). */
export type DrivingWindowResult = { ok: true; window: DrivingWindow } | { ok: false; error: unknown };

export function resolveDrivingWindow(rawQuery: unknown, now: Date = new Date()): DrivingWindowResult {
  const raw = (rawQuery ?? {}) as { from?: unknown; to?: unknown };

  if (raw.from === undefined && raw.to === undefined) {
    const legacy = legacyQuery.safeParse(rawQuery);
    if (!legacy.success) return { ok: false, error: legacy.error.flatten() };
    return { ok: true, window: { speedLimitKmh: legacy.data.speedLimit, days: legacy.data.days } };
  }

  // `days` is deliberately not even read here: from/to take precedence over it.
  const parsed = windowQuery.safeParse(rawQuery);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid query" };
  const { from, to, speedLimit } = parsed.data;

  if (!from || !to) return { ok: false, error: "`from` and `to` must be sent together" };
  if (from.getTime() >= to.getTime()) return { ok: false, error: "`from` must be earlier than `to`" };

  // A `to` in the future is not an error: nothing can have been recorded after now.
  const effectiveTo = to.getTime() > now.getTime() ? now : to;
  if (from.getTime() >= effectiveTo.getTime()) return { ok: false, error: "`from` must be in the past" };
  if (effectiveTo.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return { ok: false, error: `The range between \`from\` and \`to\` can't exceed ${MAX_WINDOW_DAYS} days` };
  }

  return { ok: true, window: { speedLimitKmh: speedLimit, days: DEFAULT_DAYS, from, to: effectiveTo } };
}
