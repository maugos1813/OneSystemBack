import { describe, expect, it } from "vitest";
import { serializeIoElements } from "../../../src/tcp-server/codec8/ioSerialize.js";

describe("serializeIoElements", () => {
  it("converts numbers, bigints and buffers into JSON-safe values", () => {
    const result = serializeIoElements({
      eventId: 1,
      elements: new Map<number, number | bigint | Buffer>([
        [21, 3],
        [78, 123456789012345678n],
        [200, Buffer.from([0xde, 0xad, 0xbe, 0xef])],
      ]),
    });

    expect(result).toEqual({
      "21": 3,
      "78": "123456789012345678",
      "200": "deadbeef",
    });
  });
});
