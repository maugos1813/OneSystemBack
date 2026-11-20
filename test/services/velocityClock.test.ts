import { describe, expect, it } from "vitest";
import { italianWallClockToInstant } from "../../src/services/fleetTime.js";

// Velocity writes the Italian wall clock as if it were UTC; the helper returns the real instant.
const wall = (iso: string) => italianWallClockToInstant(new Date(iso).getTime()).toISOString();

describe("Radius Velocity clock (Italian wall clock sent as UTC)", () => {
  it("winter (CET): 14:35 on the clock is 13:35 UTC", () => {
    expect(wall("2026-11-20T14:35:00Z")).toBe("2026-11-20T13:35:00.000Z");
  });
  it("summer (CEST): 14:35 on the clock is 12:35 UTC", () => {
    expect(wall("2026-07-14T14:35:00Z")).toBe("2026-07-14T12:35:00.000Z");
  });
  it("just after the clocks go back (Oct 25 2026, 03:30 on the clock): CET, 02:30 UTC", () => {
    expect(wall("2026-10-25T03:30:00Z")).toBe("2026-10-25T02:30:00.000Z");
  });
  it("just after the clocks go forward (Mar 29 2026, 03:30 on the clock): CEST, 01:30 UTC", () => {
    expect(wall("2026-03-29T03:30:00Z")).toBe("2026-03-29T01:30:00.000Z");
  });
});
