/** Models a tracker can be registered as. Teltonika doesn't report its model over the wire,
 * so the list only drives the picker in the UI — the API accepts any short label. */
export const DEVICE_MODELS = ["FMB204", "FMC003", "FMB920", "FMC130", "FMC150", "Otro"] as const;

export interface IoReading {
  /** AVL ID. */
  id: number;
  value: number | string;
  /** Timestamp of the record that carried this value. */
  ts: Date;
}

interface IoRow {
  ts: Date;
  ioData: Record<string, number | string>;
}

/**
 * The latest value of every IO element seen across a run of position rows.
 * A tracker configured "send on change" omits unchanged elements from most records, so the
 * newest record alone only shows a few of them — walking back through several rows gives the
 * real picture of what the device reports. `rows` may come in any order.
 */
export function collectLatestIo(rows: IoRow[]): IoReading[] {
  const newestFirst = [...rows].sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const seen = new Map<number, IoReading>();
  for (const row of newestFirst) {
    for (const [key, value] of Object.entries(row.ioData)) {
      const id = Number(key);
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.set(id, { id, value, ts: row.ts });
    }
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}
