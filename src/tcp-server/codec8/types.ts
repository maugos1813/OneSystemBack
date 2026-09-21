export const CODEC_8 = 0x08;
export const CODEC_8_EXTENDED = 0x8e;

export type CodecId = typeof CODEC_8 | typeof CODEC_8_EXTENDED;

export interface GpsElement {
  longitude: number;
  latitude: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
}

/** Raw IO elements keyed by AVL ID -> value. Values wider than 32 bits use bigint. */
export interface IoElements {
  eventId: number;
  elements: Map<number, number | bigint | Buffer>;
}

export interface AvlRecord {
  timestamp: Date;
  priority: number;
  gps: GpsElement;
  io: IoElements;
}

export interface ParsedAvlPacket {
  codecId: CodecId;
  records: AvlRecord[];
}
