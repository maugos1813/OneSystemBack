import { describe, expect, it } from "vitest";
import { BEACON_ID_PATTERN, parseBeaconPayload } from "../../src/services/beaconParser.js";

// The 385 payload of the example in Teltonika's "How to start with FMB devices and Beacons?" (8 beacons, one part).
const EXAMPLE =
  "11" +
  "214B5C049F515341FCA950D2C264414E1000050006BA" +
  "21E2C56DB5DFFB48D2B060D0F5A71096E000000000A9" +
  "2131A74BB76A79423196C916CFB9FAED45002D00159F" +
  "0700112233445566778899ABCDE0810047AE0BE80015" +
  "210F86676BEC91420A94409110029AFAC415B31A0AA1" +
  "01DE9C18E92CA5AA689697365434663222BA" +
  "21EBBBDE835D7F4965B5F06C2EDCB3A55300010080A5" +
  "01736B79686F73742E646B000010000128AD";

describe("parseBeaconPayload", () => {
  it("reads iBeacon and Eddystone entries with their RSSI, battery and temperature skipped over", () => {
    const readings = parseBeaconPayload(EXAMPLE);
    expect(readings).toHaveLength(8);
    expect(readings[0]).toEqual({ id: "ibeacon:4b5c049f515341fca950d2c264414e10-0005-0006", rssi: -70 });
    expect(readings[3]).toEqual({ id: "eddystone:00112233445566778899-abcde0810047", rssi: -82 }); // 0x07: battery + temperature follow
    expect(readings[4]).toEqual({ id: "ibeacon:0f86676bec91420a94409110029afac4-15b3-1a0a", rssi: -95 });
    expect(readings[5]).toEqual({ id: "eddystone:de9c18e92ca5aa689697-365434663222", rssi: -70 });
    expect(readings[7]).toEqual({ id: "eddystone:736b79686f73742e646b-000010000128", rssi: -83 });
  });

  it("builds ids that the registration accepts", () => {
    for (const r of parseBeaconPayload(EXAMPLE)) expect(r.id).toMatch(BEACON_ID_PATTERN);
  });

  it("keeps what it read before a truncated entry, and ignores garbage", () => {
    expect(parseBeaconPayload(EXAMPLE.slice(0, 2 + 2 * 38 + 10))).toHaveLength(1);
    expect(parseBeaconPayload("zz")).toEqual([]);
    expect(parseBeaconPayload("")).toEqual([]);
  });
});
