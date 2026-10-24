export const DOCUMENT_KINDS = ["seguro", "revision", "bollo", "tacografo", "otro"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  seguro: "Seguro",
  revision: "Revisión técnica",
  bollo: "Bollo",
  tacografo: "Tacógrafo",
  otro: "Otro documento",
};

export type DocumentState = "ok" | "soon" | "overdue";

export interface DocumentStatus {
  state: DocumentState;
  /** Whole days until it expires; negative once it has. */
  daysLeft: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days from `today` to `expiresOn` ("YYYY-MM-DD"), both read as plain dates so the time of day never matters. */
function daysBetween(today: Date, expiresOn: string): number {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const [y, m, d] = expiresOn.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - todayUtc) / DAY_MS);
}

/** Overdue from the day after it expires; "soon" from `remindDays` before (the expiry day itself still counts as valid). */
export function documentStatus(expiresOn: string, remindDays: number, today: Date): DocumentStatus {
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { state: "overdue", daysLeft };
  if (daysLeft <= remindDays) return { state: "soon", daysLeft };
  return { state: "ok", daysLeft };
}

export function documentName(kind: string, label: string | null): string {
  if (kind === "otro") return label?.trim() || DOCUMENT_LABELS.otro;
  return DOCUMENT_LABELS[kind as DocumentKind] ?? kind;
}

export function documentAlertMessage(vehicleName: string, name: string, status: DocumentStatus): string {
  if (status.state === "overdue") return `${vehicleName}: ${name} vencido hace ${Math.abs(status.daysLeft)} días`;
  if (status.daysLeft === 0) return `${vehicleName}: ${name} vence hoy`;
  return `${vehicleName}: ${name} vence en ${status.daysLeft} días`;
}
