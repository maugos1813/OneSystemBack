/** The fleet's own clock: Italy. The zone is an IANA name, so summer/winter time is applied by the platform on the right dates. */
export const FLEET_TIME_ZONE = "Europe/Rome";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: FLEET_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** Milliseconds Italy is ahead of UTC at that instant (+1 h in winter, +2 h in summer). */
function offsetMs(at: number): number {
  const parts = formatter.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Radius Velocity sends the Italian wall clock as if it were UTC: a report made at 14:35 in Italy arrives as the epoch of "14:35 UTC", which
 * is 1 hour (winter) or 2 hours (summer) in the future. `wallClockEpochMs` is that number; this returns the real instant.
 * The offset depends on the date itself, so it is settled with a second pass around a change of hour.
 */
export function italianWallClockToInstant(wallClockEpochMs: number): Date {
  let utc = wallClockEpochMs - offsetMs(wallClockEpochMs);
  utc = wallClockEpochMs - offsetMs(utc);
  return new Date(utc);
}
