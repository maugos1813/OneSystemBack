/**
 * When each tracker's ignition was on. Trackers send their beacon scans as reports of their own, and those carry no ignition
 * reading: whether the engine was running at a scan comes from the ordinary report before it. Only the moments the ignition
 * changed are kept, so a month of reports is a handful of entries.
 */
export interface IgnitionChange {
  /** Epoch ms of the first report with this state. */
  ts: number;
  on: boolean;
}

/** The ignition state at `ts` (the last change at or before it, changes sorted by time); null before the first one known. */
export function ignitionAt(changes: IgnitionChange[], ts: number): boolean | null {
  let low = 0;
  let high = changes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (changes[mid]!.ts <= ts) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found < 0 ? null : changes[found]!.on;
}
