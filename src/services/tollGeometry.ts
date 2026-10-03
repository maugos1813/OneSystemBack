export interface GeoPoint {
  lat: number;
  lng: number;
}

const METERS_PER_DEGREE_LAT = 111_320;

export interface SegmentHit {
  /** Shortest distance from the point to the segment, in meters. */
  distanceM: number;
  /** Where along the segment (0 = start, 1 = end) that closest approach happens. */
  t: number;
}

/** Local flat-earth projection around the point — plenty accurate at the ~100 m scale a
 * toll-station check cares about, and far cheaper than haversine/PostGIS per position. */
export function segmentPointDistance(a: GeoPoint, b: GeoPoint, p: GeoPoint): SegmentHit {
  const mPerDegLng = METERS_PER_DEGREE_LAT * Math.cos(p.lat * (Math.PI / 180));
  const ax = (a.lng - p.lng) * mPerDegLng;
  const ay = (a.lat - p.lat) * METERS_PER_DEGREE_LAT;
  const bx = (b.lng - p.lng) * mPerDegLng;
  const by = (b.lat - p.lat) * METERS_PER_DEGREE_LAT;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  return { distanceM: Math.hypot(ax + t * dx, ay + t * dy), t };
}

export function segmentLengthMeters(a: GeoPoint, b: GeoPoint): number {
  const mPerDegLng = METERS_PER_DEGREE_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((b.lat - a.lat) * METERS_PER_DEGREE_LAT, (b.lng - a.lng) * mPerDegLng);
}

/** Buckets points into ~5 km cells so a segment is only compared against the handful of
 * stations near it, not all ~1,000. */
export class PointGrid<T extends GeoPoint> {
  private readonly cells = new Map<string, T[]>();

  constructor(
    items: T[],
    private readonly cellDeg = 0.05,
  ) {
    for (const item of items) {
      const key = this.key(this.cell(item.lat), this.cell(item.lng));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(item);
      else this.cells.set(key, [item]);
    }
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.cells.values()) total += bucket.length;
    return total;
  }

  /** Candidates whose cell touches the segment's bounding box, padded by `marginDeg`. */
  near(a: GeoPoint, b: GeoPoint, marginDeg: number): T[] {
    const minRow = this.cell(Math.min(a.lat, b.lat) - marginDeg);
    const maxRow = this.cell(Math.max(a.lat, b.lat) + marginDeg);
    const minCol = this.cell(Math.min(a.lng, b.lng) - marginDeg);
    const maxCol = this.cell(Math.max(a.lng, b.lng) + marginDeg);

    const found: T[] = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const bucket = this.cells.get(this.key(row, col));
        if (bucket) found.push(...bucket);
      }
    }
    return found;
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellDeg);
  }

  private key(row: number, col: number): string {
    return `${row}:${col}`;
  }
}
