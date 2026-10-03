import { describe, expect, it } from "vitest";
import type { TollPlaza } from "../../src/db/schema/index.js";
import { findPlazaHits, type TrackPoint } from "../../src/services/tollDetection.service.js";
import { PointGrid, segmentPointDistance } from "../../src/services/tollGeometry.js";

// A station on a north-south road at lat 45.5, lng 9.2.
const PLAZA: TollPlaza = {
  id: "plaza-1",
  osmKey: "1",
  name: "Test Nord",
  operator: "Test SpA",
  lat: 45.5,
  lng: 9.2,
  points: [[45.5, 9.2]],
};
const grid = new PointGrid([PLAZA]);

const M_PER_DEG_LAT = 111_320;
const at = (latOffsetM: number, lngOffsetM: number, seconds: number): TrackPoint => ({
  lat: 45.5 + latOffsetM / M_PER_DEG_LAT,
  lng: 9.2 + lngOffsetM / (M_PER_DEG_LAT * Math.cos(45.5 * (Math.PI / 180))),
  ts: new Date(Date.UTC(2026, 9, 3, 10, 0, seconds)),
});

describe("segmentPointDistance", () => {
  it("measures perpendicular distance to the segment, not to the endpoints", () => {
    const a = at(-1000, 30, 0);
    const b = at(1000, 30, 60);
    const { distanceM, t } = segmentPointDistance(a, b, PLAZA);
    expect(distanceM).toBeCloseTo(30, 0);
    expect(t).toBeCloseTo(0.5, 2);
  });

  it("falls back to the nearest endpoint when the point is beyond the segment", () => {
    const { distanceM, t } = segmentPointDistance(at(500, 0, 0), at(1000, 0, 30), PLAZA);
    expect(distanceM).toBeCloseTo(500, 0);
    expect(t).toBe(0);
  });
});

describe("findPlazaHits", () => {
  it("detects a pass even when no sample lands inside the radius (1 km between reports)", () => {
    const hits = findPlazaHits(at(-500, 20, 0), [at(500, 20, 30)], grid);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.plaza.id).toBe("plaza-1");
    expect(hits[0]!.ts.getUTCSeconds()).toBe(15); // closest approach is mid-segment
  });

  it("ignores a track that stays beyond the detection radius", () => {
    expect(findPlazaHits(at(-500, 400, 0), [at(500, 400, 30)], grid)).toHaveLength(0);
  });

  it("measures to the station's gates, so a mainline beyond them is not a pass", () => {
    // Centroid sits between two gates 200 m apart; a track 100 m from the centroid but
    // ~100+ m from both gates must not match, one through a gate must.
    const twoGates: TollPlaza = {
      ...PLAZA,
      points: [
        [45.5 - 100 / M_PER_DEG_LAT, 9.2],
        [45.5 + 100 / M_PER_DEG_LAT, 9.2],
      ],
    };
    const g = new PointGrid([twoGates]);
    const lngOffset = 130 / (M_PER_DEG_LAT * Math.cos(45.5 * (Math.PI / 180)));
    const mainline: TrackPoint[] = [
      { lat: 45.499, lng: 9.2 + lngOffset, ts: new Date(Date.UTC(2026, 9, 3, 10, 0, 0)) },
      { lat: 45.501, lng: 9.2 + lngOffset, ts: new Date(Date.UTC(2026, 9, 3, 10, 0, 30)) },
    ];
    expect(findPlazaHits(undefined, mainline, g)).toHaveLength(0);
    expect(findPlazaHits(at(-500, 0, 0), [at(500, 0, 30)], g)).toHaveLength(1);
  });

  it("ignores a parked vehicle jittering next to the station", () => {
    const points = [at(20, 10, 30), at(25, 5, 60), at(18, 12, 90)];
    expect(findPlazaHits(at(22, 8, 0), points, grid)).toHaveLength(0);
  });

  it("ignores a gap too long to say anything about the road in between", () => {
    expect(findPlazaHits(at(-5000, 0, 0), [at(5000, 0, 15 * 60)], grid)).toHaveLength(0);
  });

  it("counts consecutive segments around one station as a single pass", () => {
    const track = [at(-400, 15, 0), at(-10, 15, 20), at(400, 15, 40)];
    const hits = findPlazaHits(undefined, track, grid);
    expect(hits).toHaveLength(1);
  });

  it("counts a second pass after the dedupe window as a separate pass", () => {
    const outbound = [at(-400, 15, 0), at(400, 15, 30)];
    const back = [at(400, 15, 20 * 60), at(-400, 15, 20 * 60 + 30)];
    expect(findPlazaHits(undefined, [...outbound, ...back], grid)).toHaveLength(2);
  });
});
