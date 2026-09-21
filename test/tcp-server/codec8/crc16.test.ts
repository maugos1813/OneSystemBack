import { describe, expect, it } from "vitest";
import { crc16ibm } from "../../../src/tcp-server/codec8/crc16.js";

describe("crc16ibm", () => {
  it("matches the CRC published in Teltonika's Codec 8 example #1", () => {
    // Data field (Codec ID .. Number of Data 2) from wiki.teltonika-gps.com/view/Codec
    const dataField = Buffer.from(
      "08010000016B40D8EA300100000000000000000000000000000001050215030101014" +
        "25E0F01F10000601A014E000000000000000001",
      "hex",
    );
    expect(crc16ibm(dataField).toString(16).padStart(4, "0")).toBe("c7cf");
  });

  it("returns 0 for empty input", () => {
    expect(crc16ibm(Buffer.alloc(0))).toBe(0);
  });
});
