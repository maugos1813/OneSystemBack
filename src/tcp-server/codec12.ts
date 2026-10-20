import { crc16ibm } from "./codec8/crc16.js";

/** Codec 12: the text command channel. The server sends a command, the device answers with text. */
export const CODEC_12 = 0x0c;
const TYPE_COMMAND = 0x05;
const TYPE_RESPONSE = 0x06;
const HEADER = 8; // 4-byte preamble + 4-byte data field length

/** A Codec 12 frame carrying one text command, ready to write to the device's socket. */
export function encodeCodec12Command(command: string): Buffer {
  const text = Buffer.from(command, "ascii");
  const data = Buffer.concat([
    Buffer.from([CODEC_12, 0x01, TYPE_COMMAND]),
    uint32(text.length),
    text,
    Buffer.from([0x01]),
  ]);
  return Buffer.concat([uint32(0), uint32(data.length), data, uint32(crc16ibm(data))]);
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

/** True when the frame at the head of `buf` is a Codec 12 one (the codec id sits right after the header). */
export function isCodec12Frame(buf: Buffer): boolean {
  return buf.length > HEADER && buf.readUInt32BE(0) === 0 && buf[HEADER] === CODEC_12;
}

export interface Codec12Response {
  /** The device's answer, as text. */
  text: string;
  consumedBytes: number;
}

/** Decodes a Codec 12 response frame from the head of `buf`; null while it is still incomplete. */
export function tryDecodeCodec12Response(buf: Buffer): Codec12Response | null {
  if (buf.length < HEADER) return null;
  const dataLength = buf.readUInt32BE(4);
  const total = HEADER + dataLength + 4;
  if (buf.length < total) return null;

  const data = buf.subarray(HEADER, HEADER + dataLength);
  if (crc16ibm(data) !== buf.readUInt32BE(HEADER + dataLength)) throw new Error("Codec 12 CRC-16 mismatch");
  // data = codec id, quantity, type, size(4), payload, quantity
  if (data[0] !== CODEC_12 || data[2] !== TYPE_RESPONSE) throw new Error("Unexpected Codec 12 frame type");
  const size = data.readUInt32BE(3);
  const text = data.subarray(7, 7 + size).toString("ascii");
  return { text, consumedBytes: total };
}
