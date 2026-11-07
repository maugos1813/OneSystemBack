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
  "vencimientos",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/**
 * The administration pages of a client's own account that OneSystec can also give or take away, besides the sections above:
 * its devices, its OneTrack settings and its API keys. (Its team is always its own to manage.) They are only ever for
 * owner/admin; this just lets OneSystec leave them out for a client.
 */
export const ADMIN_SECTION_KEYS = ["dispositivos", "ajustes", "api_keys"] as const;
export type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

/** Everything OneSystec can include in what a client may have. */
export const ORG_SECTION_KEYS: readonly string[] = [...MODULE_KEYS, ...ADMIN_SECTION_KEYS];

/** Keeps only known keys of an organization's allowance, without repeats; null stays null (no limit). */
export function sanitizeOrgSections(keys: readonly string[] | null | undefined): string[] | null {
  if (keys === null || keys === undefined) return null;
  const wanted = new Set(keys);
  return ORG_SECTION_KEYS.filter((key) => wanted.has(key));
}

/** Ready-made packages the admin can apply in one click. Cockpit, Conducción, Peajes and Vencimientos are in none of them. */
export const MODULE_TEMPLATES = {
  basico: ["mapa", "historial", "alertas"],
  estandar: ["mapa", "historial", "alertas", "analiticas", "vehiculos", "geocercas"],
  completo: ["mapa", "historial", "alertas", "analiticas", "vehiculos", "geocercas", "mantenimiento"],
  // Recursos humanos: only the vehicles, to follow each one's tagliando.
  recursosHumanos: ["vehiculos", "mantenimiento"],
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
 * The sections a user can use. An organization may be limited by OneSystec (`orgSections`; null = everything). Owner and admin
 * have all of what their organization has. Anyone else has what was stored for them (a user with nothing stored gets the default
 * package), within what the organization has.
 */
export function resolveModules(
  role: User["role"],
  stored: readonly string[] | null | undefined,
  orgSections: readonly string[] | null | undefined = null,
): ModuleKey[] {
  const allowed = orgSections === null || orgSections === undefined ? null : new Set(orgSections);
  const within = (keys: readonly ModuleKey[]) => (allowed ? keys.filter((key) => allowed.has(key)) : [...keys]);
  if (role === "owner" || role === "admin") return within(MODULE_KEYS);
  return within(sanitizeModules(stored ?? DEFAULT_MODULES));
}

/** The administration pages of the account an owner/admin has; nobody else has any. */
export function resolveAdminSections(role: User["role"], orgSections: readonly string[] | null | undefined = null): AdminSectionKey[] {
  if (role !== "owner" && role !== "admin") return [];
  if (orgSections === null || orgSections === undefined) return [...ADMIN_SECTION_KEYS];
  return ADMIN_SECTION_KEYS.filter((key) => orgSections.includes(key));
}
