import { crc16ibm } from "./crc16.js";
import {
  CODEC_8,
  CODEC_8_EXTENDED,
  type AvlRecord,
  type CodecId,
  type GpsElement,
  type IoElements,
  type ParsedAvlPacket,
} from "./types.js";

const PREAMBLE_LENGTH = 4;
const DATA_FIELD_LENGTH_SIZE = 4;
const CRC_SIZE = 4;

class BufferReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.offset;
  }

  hasMore(): boolean {
    return this.offset < this.buf.length;
  }

  readUInt8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUInt16(): number {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt32(): number {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readBigUInt64(): bigint {
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  readBytes(length: number): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return v;
  }
}

function readGps(reader: BufferReader): GpsElement {
  return {
    longitude: reader.readInt32() / 1e7,
    latitude: reader.readInt32() / 1e7,
    altitude: reader.readUInt16(),
    angle: reader.readUInt16(),
    satellites: reader.readUInt8(),
    speed: reader.readUInt16(),
  };
}

/** Codec 8: 1-byte AVL IDs, fixed-width value groups only (1/2/4/8 bytes). */
function readIoCodec8(reader: BufferReader): IoElements {
  const eventId = reader.readUInt8();
  reader.readUInt8(); // total IO count (informational, not needed to parse)
  const elements = new Map<number, number | bigint | Buffer>();

  const n1 = reader.readUInt8();
  for (let i = 0; i < n1; i++) elements.set(reader.readUInt8(), reader.readUInt8());

  const n2 = reader.readUInt8();
  for (let i = 0; i < n2; i++) elements.set(reader.readUInt8(), reader.readUInt16());

  const n4 = reader.readUInt8();
  for (let i = 0; i < n4; i++) elements.set(reader.readUInt8(), reader.readUInt32());

  const n8 = reader.readUInt8();
  for (let i = 0; i < n8; i++) elements.set(reader.readUInt8(), reader.readBigUInt64());

  return { eventId, elements };
}

/** Codec 8 Extended: 2-byte AVL IDs, plus a variable-length (NX) value group. */
function readIoCodec8Extended(reader: BufferReader): IoElements {
  const eventId = reader.readUInt16();
  reader.readUInt16(); // total IO count (informational)
  const elements = new Map<number, number | bigint | Buffer>();

  const n1 = reader.readUInt16();
  for (let i = 0; i < n1; i++) elements.set(reader.readUInt16(), reader.readUInt8());

  const n2 = reader.readUInt16();
  for (let i = 0; i < n2; i++) elements.set(reader.readUInt16(), reader.readUInt16());

  const n4 = reader.readUInt16();
  for (let i = 0; i < n4; i++) elements.set(reader.readUInt16(), reader.readUInt32());

  const n8 = reader.readUInt16();
  for (let i = 0; i < n8; i++) elements.set(reader.readUInt16(), reader.readBigUInt64());

  const nx = reader.readUInt16();
  for (let i = 0; i < nx; i++) {
    const id = reader.readUInt16();
    const length = reader.readUInt16();
    elements.set(id, reader.readBytes(length));
  }

  return { eventId, elements };
}

function readRecord(reader: BufferReader, codecId: CodecId): AvlRecord {
  const timestampMs = reader.readBigUInt64();
  const priority = reader.readUInt8();
  const gps = readGps(reader);
  const io = codecId === CODEC_8_EXTENDED ? readIoCodec8Extended(reader) : readIoCodec8(reader);
  return { timestamp: new Date(Number(timestampMs)), priority, gps, io };
}

export class InvalidCrcError extends Error {
  constructor() {
    super("AVL packet CRC-16 mismatch");
  }
}

export class UnsupportedCodecError extends Error {
  constructor(codecId: number) {
    super(`Unsupported codec id: 0x${codecId.toString(16)}`);
  }
}

export interface DecodeResult {
  packet: ParsedAvlPacket;
  /** Bytes consumed from the head of the input buffer for this frame. */
  consumedBytes: number;
}

/**
 * Attempts to decode a single Codec 8 / Codec 8 Extended AVL frame from the head of `buf`.
 * Returns null when `buf` does not yet contain a full frame (caller should wait for more data).
 * TCP is a byte stream, so frames can arrive split across reads or batched together —
 * callers must keep accumulating into a persistent buffer per connection and re-invoke this
 * after every chunk, consuming `consumedBytes` and retrying in case more than one frame arrived.
 */
export function tryDecodeAvlFrame(buf: Buffer): DecodeResult | null {
  if (buf.length < PREAMBLE_LENGTH + DATA_FIELD_LENGTH_SIZE) return null;

  const preamble = buf.readUInt32BE(0);
  if (preamble !== 0) {
    throw new Error(`Invalid preamble, expected 0x00000000, got 0x${preamble.toString(16)}`);
  }

  const dataFieldLength = buf.readUInt32BE(PREAMBLE_LENGTH);
  const totalFrameLength = PREAMBLE_LENGTH + DATA_FIELD_LENGTH_SIZE + dataFieldLength + CRC_SIZE;
  if (buf.length < totalFrameLength) return null;

  const dataField = buf.subarray(
    PREAMBLE_LENGTH + DATA_FIELD_LENGTH_SIZE,
    PREAMBLE_LENGTH + DATA_FIELD_LENGTH_SIZE + dataFieldLength,
  );
  const expectedCrc = buf.readUInt32BE(PREAMBLE_LENGTH + DATA_FIELD_LENGTH_SIZE + dataFieldLength);
  const actualCrc = crc16ibm(dataField);
  if (actualCrc !== expectedCrc) throw new InvalidCrcError();

  const reader = new BufferReader(dataField);
  const codecId = reader.readUInt8();
  if (codecId !== CODEC_8 && codecId !== CODEC_8_EXTENDED) {
    throw new UnsupportedCodecError(codecId);
  }
  const numberOfData1 = reader.readUInt8();

  const records: AvlRecord[] = [];
  for (let i = 0; i < numberOfData1; i++) {
    records.push(readRecord(reader, codecId));
  }

  const numberOfData2 = reader.readUInt8();
  if (numberOfData2 !== numberOfData1) {
    throw new Error(`Number of Data mismatch: NOD1=${numberOfData1} NOD2=${numberOfData2}`);
  }

  return { packet: { codecId, records }, consumedBytes: totalFrameLength };
}

/** 4-byte ACK the server must send back after successfully processing an AVL frame. */
export function encodeAck(recordCount: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(recordCount, 0);
  return buf;
}
