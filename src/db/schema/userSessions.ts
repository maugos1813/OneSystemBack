import { boolean, index, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * One sign-in on one device (a browser or one of the apps). The login token is short (minutes); this row is what keeps it
 * renewable: the refresh token is `<id>.<secret>`, only a hash of the secret is stored, and each renewal replaces it.
 * Revoking the row (sign out, "sign out everywhere", a password change) ends the session within one token's life.
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 (hex) of the current refresh secret. */
    refreshHash: varchar("refresh_hash", { length: 64 }).notNull(),
    /** The secret before it, still accepted for a few seconds (a renewal whose answer never arrived); later it means theft. */
    previousHash: varchar("previous_hash", { length: 64 }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    /** "web" or "app" (the Android apps): decides how long the session may sit unused. */
    client: varchar("client", { length: 10 }).notNull().default("web"),
    /** Whether the second step (an authenticator code or a recovery code) was passed to open it. */
    mfa: boolean("mfa").notNull().default(false),
    /** A readable name for the device ("Chrome · macOS", "App OneTrack · Android"), for the list of sessions. */
    device: varchar("device", { length: 120 }).notNull().default(""),
    ip: varchar("ip", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Ends the session if it isn't renewed by then; every renewal pushes it forward (up to `absoluteExpiresAt`). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** However active it is, it ends here. */
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("user_sessions_user_idx").on(table.userId)],
);

/** Single-use codes that stand in for the authenticator when the phone is lost. Only a hash is kept. */
export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("user_recovery_codes_user_idx").on(table.userId)],
);

export type UserSession = typeof userSessions.$inferSelect;

/**
 * The 6-digit code emailed to someone signing in from a phone (see emailCode.service.ts). Only a keyed hash is kept; a new code
 * replaces the older ones, and it dies after use, after a few wrong tries or after ten minutes.
 */
export const userEmailCodes = pgTable(
  "user_email_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("user_email_codes_user_idx").on(table.userId)],
);

/**
 * "Enter with the phone" (the WhatsApp Web way): the computer shows a QR carrying `<id>.<secret>`, a phone that is already signed in
 * scans it and authorizes, and the computer's next poll receives its own new session. Short-lived, one use; only a hash of the
 * secret is kept.
 */
export const qrLoginRequests = pgTable(
  "qr_login_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secretHash: varchar("secret_hash", { length: 64 }).notNull(),
    /** The computer asking to get in, as seen when it started: shown to the person on the phone before they authorize. */
    userAgent: varchar("user_agent", { length: 300 }).notNull().default(""),
    device: varchar("device", { length: 120 }).notNull().default(""),
    ip: varchar("ip", { length: 45 }),
    /** "pending" → "approved" (a phone said yes) → "claimed" (the computer took its session); or "denied". */
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedUserId: uuid("approved_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Whether the phone's own session had passed its second step: the computer's session inherits it. */
    approvedMfa: boolean("approved_mfa").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [index("qr_login_requests_created_idx").on(table.createdAt)],
);
