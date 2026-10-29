export interface LatLng {
  lat: number;
  lng: number;
}

/** Even-odd (ray-casting) point-in-ring test — lng as x, lat as y. */
function pointInRing(point: LatLng, ring: readonly LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.lng;
    const yi = ring[i]!.lat;
    const xj = ring[j]!.lng;
    const yj = ring[j]!.lat;
    const intersect = yi > point.lat !== yj > point.lat && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * XORing the even-odd result across every ring correctly covers both a hole (an oppositely-wound nested ring) and
 * disjoint separate areas (like Area B's few exclaves) with the same rule.
 */
export function isInsidePolygonPath(point: LatLng, path: ReadonlyArray<readonly LatLng[]>): boolean {
  let inside = false;
  for (const ring of path) if (pointInRing(point, ring)) inside = !inside;
  return inside;
}
