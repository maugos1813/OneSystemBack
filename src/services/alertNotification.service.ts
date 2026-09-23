import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { alertNotifications, type AlertNotification } from "../db/schema/index.js";

/** The currently-open episode of this alert for this vehicle, if any (resolved_at IS NULL). */
export async function getOpenNotification(
  orgId: string,
  vehicleId: string,
  alertType: string,
): Promise<AlertNotification | undefined> {
  const [row] = await db
    .select()
    .from(alertNotifications)
    .where(
      and(
        eq(alertNotifications.orgId, orgId),
        eq(alertNotifications.vehicleId, vehicleId),
        eq(alertNotifications.alertType, alertType),
        isNull(alertNotifications.resolvedAt),
      ),
    )
    .limit(1);
  return row;
}

export async function openNotification(orgId: string, vehicleId: string, alertType: string): Promise<void> {
  await db.insert(alertNotifications).values({ orgId, vehicleId, alertType });
}

export async function resolveNotification(id: string): Promise<void> {
  await db.update(alertNotifications).set({ resolvedAt: new Date() }).where(eq(alertNotifications.id, id));
}
