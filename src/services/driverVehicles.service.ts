import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createSsoTicket } from "./sso.service.js";

/**
 * The Gamonal vehicles a client may see on the OneTrack map, as decided in Gamonal Driver: its admin switches each vehicle on or off for the
 * map ("mostrar en el mapa") and gives each client user the "En vivo" section. We do not copy that decision here: we ask the Driver, as the
 * person who is looking (signing a one-minute SSO ticket for their email), for what its own "En vivo" shows them. If the Driver is down, or the
 * person has no account or no "En vivo" there, they simply get no extra vehicles.
 */
export interface SharedVehicle {
  /** The licence plate, upper-case without spaces. */
  plate: string;
  lat: number;
  lng: number;
  speed: number | null;
  ignition: boolean | null;
  /** Degrees from north, clockwise. */
  direction: number | null;
  updatedAt: string | null;
}

const TOKEN_TTL_MS = 60 * 60 * 1000;
const POSITIONS_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;

const tokens = new Map<string, { token: string; at: number }>();
const positions = new Map<string, { vehicles: SharedVehicle[]; at: number }>();

class DriverRequestError extends Error {
  constructor(readonly status: number) {
    super(`Gamonal Driver answered ${status}`);
  }
}

async function driverFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.DRIVER_API_URL.replace(/\/+$/, "")}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) throw new DriverRequestError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeTicket(email: string): Promise<string> {
  const ticket = createSsoTicket({ email, productKey: "driver" });
  const body = (await driverFetch("/auth/sso", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  })) as { data?: { accessToken?: unknown } };
  const token = body.data?.accessToken;
  if (typeof token !== "string" || !token) throw new Error("Gamonal Driver did not return a session");
  return token;
}

async function sessionFor(email: string, now: number, { fresh = false } = {}): Promise<string> {
  const cached = tokens.get(email);
  if (!fresh && cached && now - cached.at < TOKEN_TTL_MS) return cached.token;
  const token = await exchangeTicket(email);
  tokens.set(email, { token, at: now });
  return token;
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function toSharedVehicle(raw: unknown): SharedVehicle | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const lat = finite(row.lat);
  const lng = finite(row.lng);
  const plate = typeof row.targa === "string" ? row.targa.replace(/\s+/g, "").toUpperCase() : "";
  if (!plate || lat === null || lng === null) return null;
  return {
    plate,
    lat,
    lng,
    speed: finite(row.speed),
    ignition: typeof row.ignition === "boolean" ? row.ignition : null,
    direction: finite(row.direction),
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
}

async function readLive(token: string): Promise<SharedVehicle[]> {
  const body = (await driverFetch("/cliente/en-vivo", { headers: { Authorization: `Bearer ${token}` } })) as {
    data?: { vehiculos?: unknown };
  };
  const rows = Array.isArray(body.data?.vehiculos) ? body.data.vehiculos : [];
  return rows.map(toSharedVehicle).filter((v): v is SharedVehicle => v !== null);
}

/** What Gamonal Driver shows this person on its live map; an empty list for any failure (never an error for the OneTrack map). */
export async function listDriverVehiclesFor(email: string, now: number = Date.now()): Promise<SharedVehicle[]> {
  const cached = positions.get(email);
  if (cached && now - cached.at < POSITIONS_TTL_MS) return cached.vehicles;

  try {
    let vehicles: SharedVehicle[];
    try {
      vehicles = await readLive(await sessionFor(email, now));
    } catch (err) {
      // A session the Driver no longer accepts (expired, or the person was changed there): ask for a new one once.
      if (!(err instanceof DriverRequestError) || err.status !== 401) throw err;
      vehicles = await readLive(await sessionFor(email, now, { fresh: true }));
    }
    positions.set(email, { vehicles, at: now });
    return vehicles;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not read the vehicles of Gamonal Driver");
    return [];
  }
}

/** For tests: forget what was remembered. */
export function clearDriverVehiclesCache(): void {
  tokens.clear();
  positions.clear();
}
