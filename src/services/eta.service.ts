import { env } from "../config/env.js";

/**
 * How long a vehicle takes to reach an address or a city: the destination is looked up in OpenStreetMap (Nominatim) and the road
 * time comes from OSRM, both free. OSRM knows roads but not traffic, so its time is multiplied by ETA_TRAFFIC_FACTOR: an estimate,
 * not a promise. The public servers are shared, so lookups are cached and spaced out (Nominatim allows one request per second).
 */

export class EtaError extends Error {
  constructor(
    readonly status: 400 | 404 | 502,
    message: string,
  ) {
    super(message);
  }
}

export interface Point {
  lat: number;
  lng: number;
}

export interface Destination extends Point {
  label: string;
}

export interface RouteEstimate {
  destination: Destination;
  distanceKm: number;
  /** Road time with the traffic allowance, in minutes. */
  durationMin: number;
  /** The road time as OSRM gives it, with no traffic. */
  baseDurationMin: number;
  /** The road ahead, from the vehicle to the destination, as [lat, lng] points (thinned out, enough to draw it). */
  path: Array<[number, number]>;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "OneSystec/1.0 (fleet tracking; https://one-system-front-two.vercel.app)";
const TIMEOUT_MS = 8_000;
const MIN_GAP_MS = 1_100;
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_MAX = 500;
/** A long route has thousands of road points; a few hundred draw the same line. */
export const MAX_PATH_POINTS = 600;
/** Results are looked for near the vehicle first: "Via Roma" means a different street in Milan than in Naples. */
const BIAS_DEG = 2;
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 120;

const cache = new Map<string, { at: number; value: Destination | null }>();
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();

/** For tests: forget the cache and the spacing. */
export function resetEtaState(): void {
  cache.clear();
  lastCall = 0;
  queue = Promise.resolve();
}

/** Runs `job` at least MIN_GAP_MS after the previous provider call, one at a time. */
function spaced<T>(job: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return job();
  });
  queue = run.catch(() => undefined);
  return run;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new EtaError(502, "No se pudo consultar el servicio de mapas. Inténtalo de nuevo en un momento.");
  }
  if (!res.ok)
    throw new EtaError(502, "El servicio de mapas no respondió. Inténtalo de nuevo en un momento.");
  return res.json();
}

/** The place a text names, as close to `near` as the match allows; null when nothing matches. */
export async function geocode(
  text: string,
  near: Point,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<Destination | null> {
  const query = text.trim().replace(/\s+/g, " ");
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    throw new EtaError(400, `Escribe entre ${MIN_QUERY_LENGTH} y ${MAX_QUERY_LENGTH} caracteres.`);
  }
  const key = `${query.toLowerCase()}|${near.lat.toFixed(0)},${near.lng.toFixed(0)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const url = new URL(NOMINATIM);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "es");
  url.searchParams.set("addressdetails", "1");
  // left, top, right, bottom; not bounded: it only ranks nearer results first.
  url.searchParams.set(
    "viewbox",
    [near.lng - BIAS_DEG, near.lat + BIAS_DEG, near.lng + BIAS_DEG, near.lat - BIAS_DEG]
      .map((n) => n.toFixed(4))
      .join(","),
  );
  const rows = (await spaced(() => getJson(url.toString()), sleep)) as NominatimRow[];

  const first = Array.isArray(rows) ? rows[0] : undefined;
  const lat = Number(first?.lat);
  const lng = Number(first?.lon);
  const value: Destination | null =
    first && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, label: labelOf(first, query) } : null;

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

interface NominatimRow {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string | undefined>;
}

/**
 * What was found, as "Via Roma 1, Torre Pellice, Turín": street, number and the municipality, so a wrong match (the same street
 * name exists in a hundred towns) is visible. Falls back to the start of Nominatim's long name.
 */
function labelOf(row: NominatimRow, query: string): string {
  const a = row.address ?? {};
  const street = [a.road, a.house_number].filter(Boolean).join(" ");
  const place = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet;
  const area = a.county ?? a.state_district ?? a.state;
  const named = row.name && row.name !== a.road && row.name !== place ? row.name : undefined;
  const parts = [named, street, place, area].filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  if (unique.length > 0) return unique.join(", ");
  const long = (row.display_name ?? query)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return long.slice(0, 3).join(", ");
}

/** OSRM gives [lng, lat]; the map wants [lat, lng]. Keeps the first and last points and spreads the rest evenly. */
export function toPath(coordinates: unknown): Array<[number, number]> {
  if (!Array.isArray(coordinates)) return [];
  const points = coordinates.filter(
    (c): c is [number, number] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]),
  );
  const step = Math.max(1, Math.ceil(points.length / MAX_PATH_POINTS));
  const kept = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return kept.map(([lng, lat]) => [round(lat), round(lng)]);
}

/** Road distance, time and line between two points. */
export async function drive(
  from: Point,
  to: Point,
): Promise<{ distanceKm: number; baseDurationMin: number; path: Array<[number, number]> }> {
  const base = env.OSRM_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const body = (await getJson(url)) as {
    code?: string;
    routes?: Array<{ distance?: number; duration?: number; geometry?: { coordinates?: unknown } }>;
  };
  const route = body.routes?.[0];
  if (body.code !== "Ok" || !route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
    throw new EtaError(404, "No hay una ruta por carretera entre el vehículo y ese destino.");
  }
  return {
    distanceKm: Math.round((route.distance! / 1000) * 10) / 10,
    baseDurationMin: route.duration! / 60,
    path: toPath(route.geometry?.coordinates),
  };
}

export async function estimateRoute(
  from: Point,
  text: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<RouteEstimate> {
  const destination = await geocode(text, from, sleep);
  if (!destination)
    throw new EtaError(404, "No encontré ese lugar. Prueba con la ciudad, o con la calle y la ciudad.");
  const { distanceKm, baseDurationMin, path } = await drive(from, destination);
  return {
    destination,
    path,
    distanceKm,
    baseDurationMin: Math.round(baseDurationMin),
    durationMin: Math.max(1, Math.round(baseDurationMin * env.ETA_TRAFFIC_FACTOR)),
  };
}
