export interface ImeiHandshakeResult {
  imei: string;
  consumedBytes: number;
}

/**
 * The very first thing a Teltonika device sends on a new TCP connection is
 * [2 bytes length][IMEI ASCII digits]. The server must reply with a single
 * byte: 0x01 to accept the connection, 0x00 to reject it (device will disconnect).
 */
export function tryReadImei(buf: Buffer): ImeiHandshakeResult | null {
  if (buf.length < 2) return null;
  const length = buf.readUInt16BE(0);
  if (buf.length < 2 + length) return null;
  const imei = buf.subarray(2, 2 + length).toString("ascii");
  return { imei, consumedBytes: 2 + length };
}

export const IMEI_ACCEPT = Buffer.from([0x01]);
export const IMEI_REJECT = Buffer.from([0x00]);
