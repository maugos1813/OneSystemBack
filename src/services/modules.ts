import type { User } from "../db/schema/index.js";

/**
 * The OneTrack sections an admin can give or take away from a client. Pages that are administration
 * (Dispositivos, SIMs, API Keys, Ajustes, Equipo, Salud del dispositivo) are not here on purpose: they are
 * for owner/admin only and cannot be granted.
 */
export const MODULE_KEYS = [
  "mapa",
  "historial",
  "alertas",
  "analiticas",
  "vehiculos",
  "geocercas",
  "mantenimiento",
  "cockpit",
  "conduccion",
  "peajes",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Ready-made packages the admin can apply in one click. Cockpit, Conducción and Peajes are in none of them. */
export const MODULE_TEMPLATES = {
  basico: ["mapa", "historial", "alertas"],
  estandar: ["mapa", "historial", "alertas", "analiticas", "vehiculos", "geocercas"],
  completo: ["mapa", "historial", "alertas", "analiticas", "vehiculos", "geocercas", "mantenimiento"],
} as const satisfies Record<string, readonly ModuleKey[]>;

/** What a client gets until the admin chooses otherwise. */
export const DEFAULT_MODULES: readonly ModuleKey[] = MODULE_TEMPLATES.estandar;

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Keeps only known keys, without repeats, in catalog order. */
export function sanitizeModules(keys: readonly string[]): ModuleKey[] {
  const wanted = new Set(keys);
  return MODULE_KEYS.filter((key) => wanted.has(key));
}

/**
 * The sections a user can use. Owner and admin always have all of them. Anyone else has what was stored
 * for them; a user with nothing stored (created before this existed) gets the default package.
 */
export function resolveModules(role: User["role"], stored: readonly string[] | null | undefined): ModuleKey[] {
  if (role === "owner" || role === "admin") return [...MODULE_KEYS];
  return sanitizeModules(stored ?? DEFAULT_MODULES);
}
