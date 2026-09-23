import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { organizations } from "../db/schema/index.js";

export interface WorkingHoursDay {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface WorkingHours {
  monday: WorkingHoursDay;
  tuesday: WorkingHoursDay;
  wednesday: WorkingHoursDay;
  thursday: WorkingHoursDay;
  friday: WorkingHoursDay;
  saturday: WorkingHoursDay;
  sunday: WorkingHoursDay;
}

export interface AlertPreferences {
  afterHoursEnabled: boolean;
  deviceOfflineEnabled: boolean;
  deviceOfflineHours: number;
  lowBatteryEnabled: boolean;
  lowBatteryVoltage: number;
  speedingEnabled: boolean;
  speedLimitKmh: number;
  excessiveIdlingEnabled: boolean;
  excessiveIdlingMinutes: number;
  geofenceEnabled: boolean;
}

export interface OrgSettings {
  workingHours: WorkingHours;
  alerts: AlertPreferences;
}

const DEFAULT_WORKDAY: WorkingHoursDay = { enabled: true, start: "08:00", end: "18:00" };
const DEFAULT_WEEKEND: WorkingHoursDay = { enabled: false, start: "08:00", end: "18:00" };

export const DEFAULT_SETTINGS: OrgSettings = {
  workingHours: {
    monday: DEFAULT_WORKDAY,
    tuesday: DEFAULT_WORKDAY,
    wednesday: DEFAULT_WORKDAY,
    thursday: DEFAULT_WORKDAY,
    friday: DEFAULT_WORKDAY,
    saturday: DEFAULT_WEEKEND,
    sunday: DEFAULT_WEEKEND,
  },
  alerts: {
    afterHoursEnabled: true,
    deviceOfflineEnabled: true,
    deviceOfflineHours: 2,
    lowBatteryEnabled: true,
    lowBatteryVoltage: 11.5,
    speedingEnabled: true,
    speedLimitKmh: 120,
    excessiveIdlingEnabled: true,
    excessiveIdlingMinutes: 15,
    geofenceEnabled: true,
  },
};

/** Merges stored settings over the defaults so the shape can grow (new alert types,
 * new preferences) without a migration touching every existing organization's row. */
export function withDefaults(stored: unknown): OrgSettings {
  const partial = (stored ?? {}) as Partial<OrgSettings>;
  return {
    workingHours: { ...DEFAULT_SETTINGS.workingHours, ...partial.workingHours },
    alerts: { ...DEFAULT_SETTINGS.alerts, ...partial.alerts },
  };
}

export interface OrgSettingsWithName extends OrgSettings {
  orgName: string;
}

export async function getSettings(orgId: string): Promise<OrgSettingsWithName | undefined> {
  const [row] = await db
    .select({ name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) return undefined;
  return { orgName: row.name, ...withDefaults(row.settings) };
}

export interface UpdateSettingsInput {
  orgName?: string;
  workingHours?: Partial<WorkingHours>;
  alerts?: Partial<AlertPreferences>;
}

export async function updateSettings(
  orgId: string,
  patch: UpdateSettingsInput,
): Promise<OrgSettingsWithName | undefined> {
  const [existing] = await db
    .select({ name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!existing) return undefined;

  const current = withDefaults(existing.settings);
  const next: OrgSettings = {
    workingHours: { ...current.workingHours, ...patch.workingHours },
    alerts: { ...current.alerts, ...patch.alerts },
  };

  const [row] = await db
    .update(organizations)
    .set({ ...(patch.orgName ? { name: patch.orgName } : {}), settings: next })
    .where(eq(organizations.id, orgId))
    .returning({ name: organizations.name, settings: organizations.settings });

  if (!row) return undefined;
  return { orgName: row.name, ...withDefaults(row.settings) };
}
