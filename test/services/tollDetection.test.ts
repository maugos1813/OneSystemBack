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
const lngOffset = (meters: number) => meters / (M_PER_DEG_LAT * Math.cos(45.5 * (Math.PI / 180)));

/** A report `latOffsetM` north / `lngOffsetM` east of the station, `seconds` into the
 * scenario, at `speed` km/h (default: slow, as through a toll lane). */
const at = (latOffsetM: number, lngOffsetM: number, seconds: number, speed = 30): TrackPoint => ({
  lat: 45.5 + latOffsetM / M_PER_DEG_LAT,
  lng: 9.2 + lngOffset(lngOffsetM),
  ts: new Date(Date.UTC(2026, 9, 3, 10, 0, seconds)),
  speed,
});

describe("segmentPointDistance", () => {
  it("measures perpendicular distance to the segment, not to the endpoints", () => {
    const { distanceM, t } = segmentPointDistance(at(-1000, 30, 0), at(1000, 30, 60), PLAZA);
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
  it("detects a pass even when no report lands near the station (1 km between reports), but unconfirmed", () => {
    const hits = findPlazaHits(at(-500, 20, 0, 100), [at(500, 20, 30, 100)], grid);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.plaza.id).toBe("plaza-1");
    expect(hits[0]!.ts.getUTCSeconds()).toBe(15);
    expect(hits[0]!.confirmed).toBe(false);
  });

  it("confirms a pass when a report next to the gates shows the vehicle slowed down", () => {
    const hits = findPlazaHits(at(-120, 15, 0, 55), [at(60, 15, 10, 18)], grid);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.confirmed).toBe(true);
  });

  it("rejects a mainline running next to the station at cruising speed", () => {
    // 40 m from the gates, dense reports, never below 100 km/h: passing by, not through.
    expect(findPlazaHits(at(-100, 40, 0, 110), [at(100, 40, 6, 112)], grid)).toHaveLength(0);
  });

  it("ignores a track that stays beyond the detection radius", () => {
    expect(findPlazaHits(at(-500, 400, 0), [at(500, 400, 30)], grid)).toHaveLength(0);
  });

  it("measures to the station's gates, so a mainline beyond them is not a pass", () => {
    // Centroid sits between two gates 200 m apart; a track 130 m from both gates must not match.
    const twoGates: TollPlaza = {
      ...PLAZA,
      points: [
        [45.5 - 100 / M_PER_DEG_LAT, 9.2],
        [45.5 + 100 / M_PER_DEG_LAT, 9.2],
      ],
    };
    const g = new PointGrid([twoGates]);
    const mainline: TrackPoint[] = [
      { lat: 45.499, lng: 9.2 + lngOffset(130), ts: new Date(Date.UTC(2026, 9, 3, 10, 0, 0)), speed: 30 },
      { lat: 45.501, lng: 9.2 + lngOffset(130), ts: new Date(Date.UTC(2026, 9, 3, 10, 0, 30)), speed: 30 },
    ];
    expect(findPlazaHits(undefined, mainline, g)).toHaveLength(0);
    expect(findPlazaHits(at(-500, 0, 0), [at(500, 0, 30)], g)).toHaveLength(1);
  });

  it("ignores a parked vehicle jittering next to the station", () => {
    const points = [at(20, 10, 30, 0), at(25, 5, 60, 0), at(18, 12, 90, 0)];
    expect(findPlazaHits(at(22, 8, 0, 0), points, grid)).toHaveLength(0);
  });

  it("ignores a gap too long to say anything about the road in between", () => {
    expect(findPlazaHits(at(-5000, 0, 0), [at(5000, 0, 15 * 60)], grid)).toHaveLength(0);
  });

  it("counts consecutive segments around one station as a single pass", () => {
    const track = [at(-400, 15, 0), at(-10, 15, 20, 12), at(400, 15, 40)];
    expect(findPlazaHits(undefined, track, grid)).toHaveLength(1);
  });

  it("counts a second pass after the dedupe window as a separate pass", () => {
    const outbound = [at(-400, 15, 0), at(400, 15, 30)];
    const back = [at(400, 15, 20 * 60), at(-400, 15, 20 * 60 + 30)];
    expect(findPlazaHits(undefined, [...outbound, ...back], grid)).toHaveLength(2);
  });

  it("treats two clusters of the same station (same name, <2 km apart) as one pass", () => {
    const entry: TollPlaza = { ...PLAZA, id: "spinea-entry", name: "Spinea", points: [[45.5, 9.2]], lat: 45.5, lng: 9.2 };
    const exit: TollPlaza = {
      ...PLAZA,
      id: "spinea-exit",
      name: "Spinea",
      lat: 45.5 + 600 / M_PER_DEG_LAT,
      lng: 9.2,
      points: [[45.5 + 600 / M_PER_DEG_LAT, 9.2]],
    };
    const g = new PointGrid([entry, exit]);
    const track = [at(-300, 10, 0, 30), at(300, 10, 20, 25), at(900, 10, 40, 30)];
    expect(findPlazaHits(undefined, track, g)).toHaveLength(1);
  });

  it("keeps two different stations passed back to back as two passes", () => {
    const other: TollPlaza = {
      ...PLAZA,
      id: "other",
      name: "Altra Stazione",
      lat: 45.5 + 600 / M_PER_DEG_LAT,
      points: [[45.5 + 600 / M_PER_DEG_LAT, 9.2]],
    };
    const g = new PointGrid([PLAZA, other]);
    const track = [at(-300, 10, 0, 30), at(300, 10, 20, 25), at(900, 10, 40, 30)];
    expect(findPlazaHits(undefined, track, g)).toHaveLength(2);
  });
});
