/**
 * Reads the beacon list a Teltonika tracker reports as AVL ID 385 (Codec 8 Extended, stored as a hex string in
 * `positions.io_data`). Layout (big-endian), per Teltonika's "How to start with FMB devices and Beacons?":
 *   1 byte    data part: high nibble = this part, low nibble = total parts
 *   per beacon:
 *     1 byte    flags: 0x01 Eddystone with RSSI, 0x21 iBeacon with RSSI; bit 0x02 adds battery (2 bytes, mV),
 *               bit 0x04 adds temperature (2 bytes)
 *     16 bytes  Eddystone: namespace (10) + instance (6)   |   20 bytes iBeacon: UUID (16) + major (2) + minor (2)
 *     1 byte    RSSI, signed dBm (when flagged)
 *     [2 bytes battery] [2 bytes temperature]
 */

export interface BeaconReading {
  /** Stable key: "eddystone:<namespace>-<instance>" or "ibeacon:<uuid>-<major>-<minor>", lower-case hex. */
  id: string;
  /** dBm, null when the tracker did not report it. */
  rssi: number | null;
}

const FLAG_RSSI = 0x01;
const FLAG_BATTERY = 0x02;
const FLAG_TEMPERATURE = 0x04;
const FLAG_IBEACON = 0x20;

export const BEACON_ID_PATTERN = /^(eddystone|ibeacon):[0-9a-f]+(-[0-9a-f]+)*$/;

/** What the tracker reports, as the hex string stored in io_data; anything malformed yields what was read before it. */
export function parseBeaconPayload(hex: string): BeaconReading[] {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) return [];
  const bytes = Buffer.from(hex, "hex");
  const readings: BeaconReading[] = [];

  let at = 1; // skip the data-part byte
  while (at < bytes.length) {
    const flags = bytes[at]!;
    at += 1;

    const ibeacon = (flags & FLAG_IBEACON) !== 0;
    const idLength = ibeacon ? 20 : 16;
    const extra = ((flags & FLAG_RSSI) !== 0 ? 1 : 0) + ((flags & FLAG_BATTERY) !== 0 ? 2 : 0) + ((flags & FLAG_TEMPERATURE) !== 0 ? 2 : 0);
    if (at + idLength + extra > bytes.length) break;

    const raw = bytes.subarray(at, at + idLength).toString("hex");
    at += idLength;
    const id = ibeacon
      ? `ibeacon:${raw.slice(0, 32)}-${raw.slice(32, 36)}-${raw.slice(36, 40)}`
      : `eddystone:${raw.slice(0, 20)}-${raw.slice(20, 32)}`;

    let rssi: number | null = null;
    if ((flags & FLAG_RSSI) !== 0) {
      rssi = bytes.readInt8(at);
      at += 1;
    }
    if ((flags & FLAG_BATTERY) !== 0) at += 2;
    if ((flags & FLAG_TEMPERATURE) !== 0) at += 2;

    readings.push({ id, rssi });
  }
  return readings;
}
