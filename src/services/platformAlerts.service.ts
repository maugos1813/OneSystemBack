import { and, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { db } from "../db/client.js";
import { deviceCommands, devices, organizations, platformAlerts, users, vehicles, type PlatformAlert } from "../db/schema/index.js";
import { toLanguage, type Language } from "./i18n.js";
import { type AlertEmailItem, sendAlertDigest } from "./email.service.js";
import { getLatestAlarmEvents, getLatestPosition, getLatestReading } from "./position.service.js";
import { isPlatformEmail, platformEmails } from "./platform.service.js";
import { isReminderDue } from "./gpsDisconnect.js";
import { sendPushToUsers } from "./push.service.js";
import {
  DIGEST_HOUR,
  deviceFindings,
  isDigestDue,
  LOGIN_FAILURES_THRESHOLD,
  PLATFORM_REMINDER_MS,
  romeTodayAt,
  STATE_TYPES,
  TYPE_INFO,
  securityDigestPushMessage,
  securityPushMessage,
  type Finding,
  type PlatformAlertType,
} from "./platformSecurity.js";

const DAY_MS = 24 * 3_600_000;
const EMAIL_ORG = "OneSystec · Seguridad";

interface Recipient {
  id: string;
  email: string;
  language: Language;
}

/** The people of OneSystec: whoever's email is on the platform list. Nobody when the list is empty. */
export async function platformRecipients(): Promise<Recipient[]> {
  const emails = platformEmails();
  if (emails.length === 0) return [];
  const rows = await db
    .select({ id: users.id, email: users.email, language: users.language })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, emails));
  return rows.map((row) => ({ id: row.id, email: row.email, language: toLanguage(row.language) }));
}

/** Every device's state right now, across all clients and including the ones nobody has claimed. */
async function stateFindings(now: Date): Promise<Finding[]> {
  const [orgRows, vehicleRows, deviceRows] = await Promise.all([
    db.select({ id: organizations.id, name: organizations.name }).from(organizations),
    db.select({ id: vehicles.id, name: vehicles.name, plate: vehicles.plate, deviceId: vehicles.deviceId }).from(vehicles),
    db.select().from(devices),
  ]);
  const orgName = new Map(orgRows.map((org) => [org.id, org.name]));
  const vehicleOf = new Map(vehicleRows.filter((v) => v.deviceId).map((v) => [v.deviceId!, v.plate ?? v.name]));
  const found: Finding[] = [];
  for (const device of deviceRows) {
    const position = (await getLatestPosition(device.id)) ?? (await getLatestReading(device.id));
    found.push(
      ...deviceFindings({
        device,
        orgName: device.orgId ? (orgName.get(device.orgId) ?? null) : null,
        vehicleName: vehicleOf.get(device.id) ?? null,
        position,
        alarms: await getLatestAlarmEvents(device.id),
        now,
      }),
    );
  }
  return found;
}

/** Things that happened (not states): a client's order to lock a vehicle, a user created in a client's account. */
async function eventFindings(now: Date): Promise<Finding[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const found: Finding[] = [];

  const orders = await db
    .select({
      id: deviceCommands.id,
      kind: deviceCommands.kind,
      orgId: deviceCommands.orgId,
      deviceId: deviceCommands.deviceId,
      imei: devices.imei,
      orgName: organizations.name,
      vehicle: vehicles.name,
      plate: vehicles.plate,
      userName: users.name,
      userEmail: users.email,
    })
    .from(deviceCommands)
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .innerJoin(organizations, eq(organizations.id, deviceCommands.orgId))
    .leftJoin(vehicles, eq(vehicles.deviceId, devices.id))
    .leftJoin(users, eq(users.id, deviceCommands.userId))
    .where(and(gt(deviceCommands.createdAt, since), inArray(deviceCommands.kind, ["immobilize", "release"])));
  for (const order of orders) {
    if (isPlatformEmail(order.userEmail)) continue; // OneSystec's own order needs no warning
    const who = order.userName?.trim() || order.userEmail || "un usuario";
    const subject = `${order.orgName} · ${order.plate ?? order.vehicle ?? `IMEI ${order.imei}`}`;
    found.push({
      key: `immobilizer:${order.id}`,
      type: "immobilizer",
      orgId: order.orgId,
      deviceId: order.deviceId,
      subject,
      message: `${subject}: ${who} pidió ${order.kind === "immobilize" ? "BLOQUEAR" : "DESBLOQUEAR"} el vehículo`,
    });
  }

  const created = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, orgId: users.orgId, orgName: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(gt(users.createdAt, since));
  for (const user of created) {
    if (isPlatformEmail(user.email)) continue;
    found.push({
      key: `new_user:${user.id}`,
      type: "new_user",
      orgId: user.orgId,
      deviceId: null,
      subject: user.orgName,
      message: `${user.orgName}: se creó el usuario ${user.name.trim() || user.email} (${user.role})`,
    });
  }
  return found;
}

/** Keeps the open episodes in step with what is true now: new ones open, the ones that ended close. */
async function reconcile(found: Finding[], now: Date): Promise<void> {
  const open = await db.select().from(platformAlerts).where(and(isNull(platformAlerts.resolvedAt), inArray(platformAlerts.type, STATE_TYPES)));
  const openByKey = new Map(open.map((row) => [row.key, row]));
  const nowKeys = new Set(found.map((f) => f.key));

  for (const f of found) {
    const existing = openByKey.get(f.key);
    if (!existing) {
      await db.insert(platformAlerts).values({
        key: f.key,
        type: f.type,
        severity: TYPE_INFO[f.type].severity,
        orgId: f.orgId,
        deviceId: f.deviceId,
        subject: f.subject,
        message: f.message,
        firstTriggeredAt: now,
      });
    } else if (existing.message !== f.message) {
      await db.update(platformAlerts).set({ message: f.message }).where(eq(platformAlerts.id, existing.id));
    }
  }
  for (const row of open) {
    if (!nowKeys.has(row.key)) await db.update(platformAlerts).set({ resolvedAt: now }).where(eq(platformAlerts.id, row.id));
  }
}

/** One-off events are written once, already closed: they happened, they do not last. */
async function recordEvents(found: Finding[], now: Date): Promise<void> {
  if (found.length === 0) return;
  const known = await db.select({ key: platformAlerts.key }).from(platformAlerts).where(inArray(platformAlerts.key, found.map((f) => f.key)));
  const seen = new Set(known.map((row) => row.key));
  for (const f of found) {
    if (seen.has(f.key)) continue;
    await db.insert(platformAlerts).values({
      key: f.key,
      type: f.type,
      severity: TYPE_INFO[f.type].severity,
      orgId: f.orgId,
      deviceId: f.deviceId,
      subject: f.subject,
      message: f.message,
      firstTriggeredAt: now,
      resolvedAt: now,
    });
  }
}

const toEmailItem = (row: PlatformAlert): AlertEmailItem => ({
  vehicleName: row.subject,
  message: { es: row.message, it: row.message },
});

/** The urgent ones: announced by push and email the first time, and by push again every few minutes while a device stays down. */
async function notifyUrgent(recipients: Recipient[], now: Date): Promise<void> {
  const rows = await db.select().from(platformAlerts).where(eq(platformAlerts.severity, "urgent"));
  const fresh = rows.filter((row) => row.lastNotifiedAt === null);
  const reminders = rows.filter(
    (row) =>
      row.lastNotifiedAt !== null &&
      row.resolvedAt === null &&
      TYPE_INFO[row.type as PlatformAlertType]?.reminders &&
      isReminderDue({ firstTriggeredAt: row.firstTriggeredAt, lastNotifiedAt: row.lastNotifiedAt }, PLATFORM_REMINDER_MS, now),
  );
  if (fresh.length === 0 && reminders.length === 0) return;

  const ids = recipients.map((r) => r.id);
  if (fresh.length > 0) {
    await sendPushToUsers(ids, securityPushMessage(fresh.map((r) => r.message), false));
    if (env.PLATFORM_SECURITY_EMAIL) for (const to of recipients) await sendAlertDigest(to.email, EMAIL_ORG, fresh.map(toEmailItem), to.language);
  }
  if (reminders.length > 0) await sendPushToUsers(ids, securityPushMessage(reminders.map((r) => r.message), true));

  await db
    .update(platformAlerts)
    .set({ lastNotifiedAt: now })
    .where(inArray(platformAlerts.id, [...fresh, ...reminders].map((r) => r.id)));
}

/** The daily email (from 08:00 in Rome): what is new, and what is still open from before. */
async function sendDailyDigest(recipients: Recipient[], now: Date): Promise<void> {
  const [lastRow] = await db.select({ last: max(platformAlerts.digestedAt) }).from(platformAlerts).where(eq(platformAlerts.severity, "digest"));
  if (!isDigestDue(now, lastRow?.last ?? null)) return;

  const rows = await db.select().from(platformAlerts).where(eq(platformAlerts.severity, "digest"));
  const slot = romeTodayAt(now, DIGEST_HOUR);
  const due = rows.filter((row) => {
    if (row.type === "login_failed" && row.count < LOGIN_FAILURES_THRESHOLD) return false;
    if (row.digestedAt === null) return true;
    // Still open from an earlier email: said again each day until it ends.
    return row.resolvedAt === null && row.digestedAt.getTime() < slot.getTime();
  });
  if (due.length === 0) return;

  if (env.PLATFORM_SECURITY_EMAIL) {
    for (const to of recipients) await sendAlertDigest(to.email, `${EMAIL_ORG} · resumen diario`, due.map(toEmailItem), to.language);
  } else {
    await sendPushToUsers(recipients.map((r) => r.id), securityDigestPushMessage(due.map((r) => r.message)));
  }
  await db.update(platformAlerts).set({ digestedAt: now }).where(inArray(platformAlerts.id, due.map((r) => r.id)));
}

/** One pass of OneSystec's security watch. The first ever pass only learns what is already going on, so a backlog is not announced. */
export async function evaluatePlatformSecurity(now: Date = new Date()): Promise<void> {
  const recipients = await platformRecipients();
  if (recipients.length === 0) return;

  const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(platformAlerts);
  const baseline = (countRow?.n ?? 0) === 0;

  const states = await stateFindings(now);
  await reconcile(states, now);
  await recordEvents(await eventFindings(now), now);

  if (baseline) {
    await db.update(platformAlerts).set({ lastNotifiedAt: now, digestedAt: now });
    logger.info({ findings: states.length }, "Platform security watch learned the current state");
    return;
  }
  await notifyUrgent(recipients, now);
  await sendDailyDigest(recipients, now);
}

/** A failed sign-in: counted per account per day, and told only once it is many (someone guessing a password). */
export async function recordLoginFailure(email: string, now: Date = new Date()): Promise<void> {
  const account = email.trim().toLowerCase();
  const key = `login_failed:${account}:${now.toISOString().slice(0, 10)}`.slice(0, 160);
  const message = `Intentos fallidos de acceso a la cuenta ${account}`;
  const [existing] = await db.select().from(platformAlerts).where(eq(platformAlerts.key, key)).limit(1);
  if (existing) {
    await db.update(platformAlerts).set({ count: existing.count + 1, message: `${message} (${existing.count + 1} hoy)` }).where(eq(platformAlerts.id, existing.id));
    return;
  }
  await db.insert(platformAlerts).values({
    key,
    type: "login_failed",
    severity: "digest",
    subject: account,
    message: `${message} (1 hoy)`,
    firstTriggeredAt: now,
    resolvedAt: now,
  });
}
