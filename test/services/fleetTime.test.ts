import { describe, expect, it } from "vitest";
import { isAfterHours } from "../../src/services/alertEvaluation.service.js";

const day = { enabled: true, start: "08:00", end: "18:00" };
const week = { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: { ...day, enabled: false }, sunday: { ...day, enabled: false } };

describe("working hours follow Italian wall-clock time", () => {
  it("winter (CET, UTC+1): 17:30 UTC is 18:30 in Rome → after hours", () => {
    expect(isAfterHours(new Date("2026-01-14T17:30:00Z"), week)).toBe(true);
    expect(isAfterHours(new Date("2026-01-14T16:30:00Z"), week)).toBe(false);
  });
  it("summer (CEST, UTC+2): 16:30 UTC is 18:30 in Rome → after hours", () => {
    expect(isAfterHours(new Date("2026-07-14T16:30:00Z"), week)).toBe(true);
    expect(isAfterHours(new Date("2026-07-14T15:30:00Z"), week)).toBe(false);
  });
  it("uses the Italian weekday around midnight", () => {
    // Friday 23:30 UTC in summer is already Saturday 01:30 in Rome (a disabled day)
    expect(isAfterHours(new Date("2026-07-17T23:30:00Z"), week)).toBe(true);
  });
});
