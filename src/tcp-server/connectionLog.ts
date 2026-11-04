import { randomBytes } from "node:crypto";
import type { AvlRecord } from "./codec8/types.js";
import { AVL_ID } from "./codec8/avlIds.js";

/** Bytes of a packet that a parse-error log shows: enough to see the preamble, length and codec without flooding the logs. */
export const PARSE_ERROR_HEX_BYTES = 64;

/** AVL 800 is the external voltage on the newer Teltonika generation; older ones report it as 66. */
const EXTERNAL_VOLTAGE_ALT_ID = 800;

/** A short random id (6 hex characters) to follow one connection through the logs. */
export function newConnectionId(): string {
  return randomBytes(3).toString("hex");
}

/** "1.2.3.4" for an IPv4 address that Node reports in its IPv6-mapped form ("::ffff:1.2.3.4"). */
export function plainIp(address: string | undefined): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/** "08" or "8E": the codec byte as the Teltonika documentation writes it. */
export function codecLabel(codecId: number): string {
  return codecId.toString(16).toUpperCase().padStart(2, "0");
}

export function isoOrInvalid(date: Date): string {
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}

export function hexHead(buf: Buffer, maxBytes = PARSE_ERROR_HEX_BYTES): string {
  return buf.subarray(0, maxBytes).toString("hex");
}

function numeric(value: number | bigint | Buffer | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/**
 * What the last record of a packet says, as `key=value` pairs: where it is, how fast, how many satellites, and — only when the
 * record carries them — ignition (AVL 239), movement (AVL 240) and external voltage (AVL 66, or 800 when that is the one sent).
 */
export function describeRecord(record: AvlRecord): string {
  const { gps, io } = record;
  const parts = [`lat=${gps.latitude.toFixed(6)}`, `lng=${gps.longitude.toFixed(6)}`, `speed=${gps.speed}`, `sats=${gps.satellites}`];

  const ignition = numeric(io.elements.get(AVL_ID.IGNITION));
  if (ignition !== undefined) parts.push(`ign=${ignition}`);
  const movement = numeric(io.elements.get(AVL_ID.MOVEMENT));
  if (movement !== undefined) parts.push(`mov=${movement}`);

  const voltageId = io.elements.has(AVL_ID.EXTERNAL_VOLTAGE) ? AVL_ID.EXTERNAL_VOLTAGE : EXTERNAL_VOLTAGE_ALT_ID;
  const voltage = numeric(io.elements.get(voltageId));
  if (voltage !== undefined) parts.push(`vext=${voltage}`, `vext_avl=${voltageId}`);

  return parts.join(" ");
}
