import { describe, expect, it } from "vitest";
import { crc16ibm } from "../../src/tcp-server/codec8/crc16.js";
import { encodeCodec12Command, isCodec12Frame, tryDecodeCodec12Response } from "../../src/tcp-server/codec12.js";

/** What the device sends back: codec 12, 1 response, type 0x06, the text, then the CRC. */
function responseFrame(text: string): Buffer {
  const payload = Buffer.from(text, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const data = Buffer.concat([Buffer.from([0x0c, 0x01, 0x06]), size, payload, Buffer.from([0x01])]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc16ibm(data));
  return Buffer.concat([head, data, crc]);
}

describe("Codec 12", () => {
  it("encodes a command exactly as in Teltonika's documented example (getinfo)", () => {
    expect(encodeCodec12Command("getinfo").toString("hex").toUpperCase()).toBe(
      "000000000000000F0C010500000007676574696E666F0100004312",
    );
  });

  it("decodes the answer of the device", () => {
    const frame = responseFrame("DOUT1:1 Timeout:INFINITY");
    expect(isCodec12Frame(frame)).toBe(true);
    expect(tryDecodeCodec12Response(frame)).toEqual({ text: "DOUT1:1 Timeout:INFINITY", consumedBytes: frame.length });
  });

  it("waits for the rest of a split frame and tells a Codec 8 frame apart", () => {
    const frame = responseFrame("OK");
    expect(tryDecodeCodec12Response(frame.subarray(0, frame.length - 3))).toBeNull();
    const codec8 = Buffer.from("000000000000000008010000000000000000", "hex");
    expect(isCodec12Frame(codec8)).toBe(false);
  });

  it("rejects a frame whose CRC does not match", () => {
    const frame = responseFrame("OK");
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;
    expect(() => tryDecodeCodec12Response(frame)).toThrow(/CRC/);
  });
});
