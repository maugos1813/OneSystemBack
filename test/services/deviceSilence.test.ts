import { describe, expect, it } from "vitest";
import { wasParkedWithEngineOff } from "../../src/services/deviceSilence.js";

describe("wasParkedWithEngineOff", () => {
  it("is true when the last report had the engine off and the vehicle stopped", () => {
    expect(wasParkedWithEngineOff({ speed: 0, ioData: { "239": 0 } })).toBe(true);
    expect(wasParkedWithEngineOff({ speed: 0, ioData: { "239": "0" } })).toBe(true);
  });

  it("is false while in use, so going quiet then is still flagged", () => {
    expect(wasParkedWithEngineOff({ speed: 0, ioData: { "239": 1 } })).toBe(false);
    expect(wasParkedWithEngineOff({ speed: 35, ioData: { "239": 0 } })).toBe(false);
  });

  it("is false when there is no ignition reading or no report at all", () => {
    expect(wasParkedWithEngineOff({ speed: 0, ioData: {} })).toBe(false);
    expect(wasParkedWithEngineOff(undefined)).toBe(false);
  });
});
