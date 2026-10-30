import { describe, expect, it } from "vitest";
import { ignitionAt, type IgnitionChange } from "../../src/services/ignitionTimeline.js";

describe("the ignition at the moment of a beacon scan", () => {
  const changes: IgnitionChange[] = [
    { ts: 1_000, on: true },
    { ts: 5_000, on: false },
    { ts: 9_000, on: true },
  ];

  it("is the state of the last change at or before the moment", () => {
    expect(ignitionAt(changes, 1_000)).toBe(true);
    expect(ignitionAt(changes, 4_999)).toBe(true);
    expect(ignitionAt(changes, 5_000)).toBe(false);
    expect(ignitionAt(changes, 8_999)).toBe(false);
    expect(ignitionAt(changes, 50_000)).toBe(true);
  });

  it("is unknown before the first change, and with no changes at all", () => {
    expect(ignitionAt(changes, 999)).toBeNull();
    expect(ignitionAt([], 1_000)).toBeNull();
  });
});
