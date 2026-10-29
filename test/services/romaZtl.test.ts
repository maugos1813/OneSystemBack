import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isInsidePolygonPath } from "../../src/services/geofenceGeometry.js";

/** The official Rome ZTL outlines shipped in scripts/data/romaZtl.json: sound shapes that contain what they should. */

interface Zone {
  name: string;
  alertOnEnter: boolean;
  path: Array<Array<{ lat: number; lng: number }>>;
}
const zones = (JSON.parse(readFileSync(new URL("../../scripts/data/romaZtl.json", import.meta.url), "utf8")) as { zones: Zone[] }).zones;
const zone = (name: string) => zones.find((z) => z.name === name)!;
const inside = (name: string, lat: number, lng: number) => isInsidePolygonPath({ lat, lng }, zone(name).path);

describe("Rome ZTL data", () => {
  it("has unique names that fit a geofence, and rings the app can take (at least 3 points, at most 20 rings)", () => {
    expect(new Set(zones.map((z) => z.name)).size).toBe(zones.length);
    for (const z of zones) {
      expect(z.name.length, z.name).toBeLessThanOrEqual(100);
      expect(z.path.length, z.name).toBeGreaterThanOrEqual(1);
      expect(z.path.length, z.name).toBeLessThanOrEqual(20);
      for (const ring of z.path) expect(ring.length, z.name).toBeGreaterThanOrEqual(3);
    }
  });

  it("lies in Rome (nothing near Milan or off the map)", () => {
    for (const z of zones) {
      for (const p of z.path.flat()) {
        expect(p.lat, z.name).toBeGreaterThan(41.7);
        expect(p.lat, z.name).toBeLessThan(42.1);
        expect(p.lng, z.name).toBeGreaterThan(12.3);
        expect(p.lng, z.name).toBeLessThan(12.7);
      }
    }
  });

  it("covers the places each zone is known for, and not the ones it is not", () => {
    expect(inside("ZTL Roma Centro (diurna)", 41.8902, 12.4922)).toBe(true); // Colosseo
    expect(inside("ZTL Roma Centro (diurna)", 41.8986, 12.4769)).toBe(true); // Piazza Navona
    expect(inside("ZTL Roma Centro (diurna)", 41.9109, 12.4818)).toBe(false); // Villa Borghese side, outside
    expect(inside("ZTL Roma Trastevere (diurna)", 41.8896, 12.4700)).toBe(true); // Piazza Trilussa area
    expect(inside("ZTL Roma Tridente (A1)", 41.9060, 12.4823)).toBe(true); // Piazza di Spagna
    expect(inside("ZTL Roma Fascia Verde", 41.9028, 12.4964)).toBe(true); // Termini
    expect(inside("ZTL Roma Fascia Verde", 45.4642, 9.19)).toBe(false); // Milan
    expect(inside("ZTL Roma Fascia Verde", 41.7990, 12.2460)).toBe(false); // Fiumicino airport, outside
  });

  it("only warns on entering the day zones; the big environmental zone is just drawn", () => {
    expect(zone("ZTL Roma Fascia Verde").alertOnEnter).toBe(false);
    expect(zone("ZTL Roma Centro (diurna)").alertOnEnter).toBe(true);
  });
});
