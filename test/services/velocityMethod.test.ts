import { describe, expect, it, vi } from "vitest";

/** OneTrack's score for vehicles Velocity does not track: the same formula Velocity's own report uses (events per hour of driving). */

vi.mock("../../src/db/client.js", () => ({ db: {} }));
vi.mock("../../src/config/logger.js", () => ({ logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }));
vi.mock("../../src/config/env.js", () => ({ env: { RADIUS_VELOCITY_CUSTOMER_ID: "1" } }));
vi.mock("../../src/services/radiusVelocity.service.js", () => ({ radiusAccessToken: async () => "t" }));

const { summarize, velocityScore, VELOCITY_METHOD } = await import("../../src/services/drivingStyle.service.js");

// Real rows of Velocity's Driver Performance report (19–26 Oct 2026): [events, hours of driving, Velocity's score].
const ACCELERATION = [[86, 62.41, 62], [53, 59.45, 75], [25, 43.57, 84], [60, 37.3, 55], [0, 11.49, 100]] as const;
const BRAKING = [[5, 11.49, 76], [7, 52.19, 93], [63, 37.69, 7], [37, 70.24, 71], [54, 59.64, 50], [52, 36.31, 20], [26, 41.38, 65]] as const;
const CORNERING = [[4, 11.49, 84], [81, 62.41, 35], [27, 52.19, 75], [8, 9.68, 59], [17, 59.45, 86], [62, 37.3, 19]] as const;

describe("Velocity's formula", () => {
  it("gives Velocity's own acceleration score exactly, and braking and cornering to within 2 and 1 points", () => {
    for (const [events, hours, expected] of ACCELERATION) expect(velocityScore(events, hours, "acceleration")).toBe(expected);
    for (const [events, hours, expected] of BRAKING) expect(Math.abs(velocityScore(events, hours, "braking") - expected)).toBeLessThanOrEqual(2);
    for (const [events, hours, expected] of CORNERING) expect(Math.abs(velocityScore(events, hours, "cornering") - expected)).toBeLessThanOrEqual(1);
  });

  it("never goes below 0 or above 100", () => {
    expect(velocityScore(500, 2, "braking")).toBe(0);
    expect(velocityScore(0, 10, "cornering")).toBe(100);
  });
});

const stats = (over: Partial<Parameters<typeof summarize>[0] & object> = {}) => ({
  samples: 5_000,
  distanceKm: 300,
  denseKm: 300,
  movingSeconds: 10 * 3600,
  trips: 12,
  harshBraking: 5,
  harshAcceleration: 3,
  harshCornering: 4,
  speeding: 20,
  ...over,
});

describe("summarizing by hour of driving", () => {
  it("scores each category by its events per hour and averages the four, like Velocity", () => {
    const s = summarize(stats(), "per_hour");
    expect(s.scoring).toBe("per_hour");
    expect(s.quality).toBe("full");
    expect(s.scores).toMatchObject({
      harshBraking: velocityScore(5, 10, "braking"),
      harshAcceleration: velocityScore(3, 10, "acceleration"),
      harshCornering: velocityScore(4, 10, "cornering"),
      speeding: velocityScore(20, 10, "speeding"),
    });
    const { harshBraking, harshAcceleration, harshCornering, speeding, overall } = s.scores!;
    expect(overall).toBe(Math.round((harshBraking! + harshAcceleration! + harshCornering! + speeding) / 4));
  });

  it("does not score under the minimum hours of driving, but still returns the counts", () => {
    const s = summarize(stats({ movingSeconds: VELOCITY_METHOD.minHours * 3600 - 60 }), "per_hour");
    expect(s.quality).toBe("insufficient_data");
    expect(s.scores).toBeNull();
    expect(s.incidents.harshBraking).toBe(5);
  });

  it("judges by hours, not by kilometres: a short drive with many hours is still scored", () => {
    expect(summarize(stats({ distanceKm: 5, movingSeconds: 6 * 3600 }), "per_hour").quality).toBe("full");
    expect(summarize(stats({ distanceKm: 5, movingSeconds: 6 * 3600 }), "per_100km").quality).toBe("insufficient_data");
  });

  it("scores only the speed when the device reports too sparsely to see harsh events", () => {
    const s = summarize(stats({ denseKm: 10 }), "per_hour");
    expect(s.quality).toBe("speeding_only");
    expect(s.scores?.overall).toBe(velocityScore(20, 10, "speeding"));
  });

  it("keeps the original per-100-km calculation by default (the public API)", () => {
    const s = summarize(stats());
    expect(s.scoring).toBe("per_100km");
    expect(s.scores?.harshBraking).toBe(Math.round(100 - (5 / 300) * 100 * 5));
  });
});
