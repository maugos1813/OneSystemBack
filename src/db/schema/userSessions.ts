import { boolean, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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
