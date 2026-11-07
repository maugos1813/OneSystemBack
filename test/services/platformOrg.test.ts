import { describe, expect, it } from "vitest";
import { isPlatformOrg, platformOrgIds } from "../../src/services/platform.service.js";

describe("who is the platform", () => {
  it("nobody when the variable is unset or empty (fails closed)", () => {
    expect(isPlatformOrg("abc", "")).toBe(false);
    expect(isPlatformOrg("abc", undefined)).toBe(false);
    expect(platformOrgIds(" , ")).toEqual([]);
  });
  it("matches listed ids, ignoring case and spaces", () => {
    expect(isPlatformOrg("AAA-1", " aaa-1 , bbb-2 ")).toBe(true);
    expect(isPlatformOrg("bbb-2", "aaa-1,bbb-2")).toBe(true);
    expect(isPlatformOrg("ccc-3", "aaa-1,bbb-2")).toBe(false);
  });
  it("never matches a missing org id", () => {
    expect(isPlatformOrg(undefined, "aaa-1")).toBe(false);
    expect(isPlatformOrg(null, "aaa-1")).toBe(false);
  });
});
