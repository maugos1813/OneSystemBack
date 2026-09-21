import { describe, expect, it } from "vitest";
import { tryReadImei } from "../../../src/tcp-server/codec8/imei.js";
import { InvalidCrcError, encodeAck, tryDecodeAvlFrame } from "../../../src/tcp-server/codec8/parser.js";
import { CODEC_8, CODEC_8_EXTENDED } from "../../../src/tcp-server/codec8/types.js";
import {
  CODEC8_EXAMPLE_1_EXPECTED_ACK,
  CODEC8_EXAMPLE_1_HEX,
  CODEC8_EXAMPLE_2_EXPECTED_ACK,
  CODEC8_EXAMPLE_2_HEX,
  CODEC8_EXAMPLE_3_EXPECTED_ACK,
  CODEC8_EXAMPLE_3_HEX,
  CODEC8_EXTENDED_EXAMPLE_EXPECTED_ACK,
  CODEC8_EXTENDED_EXAMPLE_HEX,
  SAMPLE_IMEI,
  SAMPLE_IMEI_HANDSHAKE_HEX,
} from "./fixtures.js";

describe("tryReadImei", () => {
  it("parses the length-prefixed IMEI handshake", () => {
    const buf = Buffer.from(SAMPLE_IMEI_HANDSHAKE_HEX, "hex");
    const result = tryReadImei(buf);
    expect(result).toEqual({ imei: SAMPLE_IMEI, consumedBytes: buf.length });
  });

  it("returns null when not enough bytes have arrived yet", () => {
    const buf = Buffer.from(SAMPLE_IMEI_HANDSHAKE_HEX, "hex");
    expect(tryReadImei(buf.subarray(0, 5))).toBeNull();
    expect(tryReadImei(Buffer.alloc(1))).toBeNull();
  });
});

describe("tryDecodeAvlFrame — Codec 8", () => {
  it("decodes example #1 (one record, every IO width) and matches the documented values", () => {
    const buf = Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex");
    const result = tryDecodeAvlFrame(buf);
    expect(result).not.toBeNull();
    expect(result!.consumedBytes).toBe(buf.length);

    const { packet } = result!;
    expect(packet.codecId).toBe(CODEC_8);
    expect(packet.records).toHaveLength(CODEC8_EXAMPLE_1_EXPECTED_ACK);

    const record = packet.records[0]!;
    expect(record.timestamp.toISOString()).toBe("2019-06-10T10:04:46.000Z");
    expect(record.priority).toBe(1);
    expect(record.io.eventId).toBe(1);
    expect(record.io.elements.get(21)).toBe(3); // GSM Signal
    expect(record.io.elements.get(1)).toBe(1); // DIN1
    expect(record.io.elements.get(66)).toBe(0x5e0f); // External Voltage
    expect(record.io.elements.get(241)).toBe(0x00601a); // Active GSM Operator
    expect(record.io.elements.get(78)).toBe(0n); // iButton
  });

  it("decodes example #2 (1-byte and 2-byte IO only)", () => {
    const buf = Buffer.from(CODEC8_EXAMPLE_2_HEX, "hex");
    const result = tryDecodeAvlFrame(buf);
    expect(result!.consumedBytes).toBe(buf.length);
    expect(result!.packet.records).toHaveLength(CODEC8_EXAMPLE_2_EXPECTED_ACK);
    expect(result!.packet.records[0]!.timestamp.toISOString()).toBe("2019-06-10T10:05:36.000Z");
    expect(result!.packet.records[0]!.io.elements.get(66)).toBe(0x5e10);
  });

  it("decodes example #3 (two records in one packet)", () => {
    const buf = Buffer.from(CODEC8_EXAMPLE_3_HEX, "hex");
    const result = tryDecodeAvlFrame(buf);
    expect(result!.consumedBytes).toBe(buf.length);
    expect(result!.packet.records).toHaveLength(CODEC8_EXAMPLE_3_EXPECTED_ACK);
    expect(result!.packet.records[0]!.io.elements.get(1)).toBe(0);
    expect(result!.packet.records[1]!.io.elements.get(1)).toBe(1);
  });
});

describe("tryDecodeAvlFrame — Codec 8 Extended", () => {
  it("decodes 2-byte-wide IDs/lengths and matches the documented values", () => {
    const buf = Buffer.from(CODEC8_EXTENDED_EXAMPLE_HEX, "hex");
    const result = tryDecodeAvlFrame(buf);
    expect(result).not.toBeNull();
    expect(result!.consumedBytes).toBe(buf.length);

    const { packet } = result!;
    expect(packet.codecId).toBe(CODEC_8_EXTENDED);
    expect(packet.records).toHaveLength(CODEC8_EXTENDED_EXAMPLE_EXPECTED_ACK);

    const record = packet.records[0]!;
    expect(record.timestamp.toISOString()).toBe("2019-06-10T11:36:32.000Z");
    expect(record.io.elements.get(1)).toBe(1); // DIN1
    expect(record.io.elements.get(17)).toBe(0x1d); // Axis X
    expect(record.io.elements.get(16)).toBe(0x015e2c88); // Total Odometer
    expect(record.io.elements.get(11)).toBe(0x000000003544c87an); // ICCID1
    expect(record.io.elements.get(14)).toBe(0x000000001dd7e06an); // ICCID2
  });
});

describe("tryDecodeAvlFrame — streaming behaviour", () => {
  it("returns null when the buffer holds fewer bytes than the header", () => {
    expect(tryDecodeAvlFrame(Buffer.alloc(0))).toBeNull();
    expect(tryDecodeAvlFrame(Buffer.alloc(6))).toBeNull();
  });

  it("returns null when the header is complete but the body hasn't fully arrived", () => {
    const full = Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex");
    expect(tryDecodeAvlFrame(full.subarray(0, full.length - 1))).toBeNull();
  });

  it("decodes only the first frame and reports consumedBytes when two frames are concatenated", () => {
    const first = Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex");
    const second = Buffer.from(CODEC8_EXAMPLE_2_HEX, "hex");
    const combined = Buffer.concat([first, second]);

    const firstResult = tryDecodeAvlFrame(combined);
    expect(firstResult!.consumedBytes).toBe(first.length);

    const rest = combined.subarray(firstResult!.consumedBytes);
    const secondResult = tryDecodeAvlFrame(rest);
    expect(secondResult!.consumedBytes).toBe(second.length);
    expect(rest.subarray(secondResult!.consumedBytes)).toHaveLength(0);
  });

  it("throws InvalidCrcError when the CRC doesn't match", () => {
    const buf = Buffer.from(CODEC8_EXAMPLE_1_HEX, "hex");
    buf.writeUInt8(buf.readUInt8(buf.length - 1) ^ 0xff, buf.length - 1); // corrupt the last CRC byte
    expect(() => tryDecodeAvlFrame(buf)).toThrow(InvalidCrcError);
  });
});

describe("encodeAck", () => {
  it("encodes the record count as a 4-byte big-endian integer", () => {
    expect(encodeAck(1)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01]));
    expect(encodeAck(2)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x02]));
  });
});
