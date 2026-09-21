import type { IoElements } from "./types.js";

/** JSON-safe representation of an IO element map, suitable for a jsonb column. */
export type SerializedIo = Record<string, number | string>;

export function serializeIoElements(io: IoElements): SerializedIo {
  const out: SerializedIo = {};
  for (const [id, value] of io.elements) {
    if (typeof value === "bigint") {
      out[id] = value.toString();
    } else if (Buffer.isBuffer(value)) {
      out[id] = value.toString("hex");
    } else {
      out[id] = value;
    }
  }
  return out;
}
