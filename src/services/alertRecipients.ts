import type { AlertEmailItem } from "./email.service.js";
import type { Language } from "./i18n.js";

export interface AlertRecipient {
  userId: string;
  email: string;
  /** The language this person reads the alerts in. */
  language: Language;
  /** The flota this person is limited to, or null for the organization's owner, who gets everything. */
  fleetGroup: string | null;
}

/**
 * What one recipient is allowed to be told about. The owner gets every alert of the organization; a client user only
 * the ones about vehicles of their own flota — never another client's, and never an alert with no flota.
 */
export function alertsForRecipient(items: readonly AlertEmailItem[], recipient: AlertRecipient): AlertEmailItem[] {
  if (recipient.fleetGroup === null) return [...items];
  return items.filter((item) => item.fleetGroup === recipient.fleetGroup);
}
