import { boolean, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * "Sign in with OneTrack": other apps of the owner (App Piazza) read a person's vehicles, with that person's consent. OAuth 2.0 authorization
 * code + PKCE. Nothing secret is stored in clear: the client secret, the codes and the tokens are kept only as SHA-256 hashes.
 */

/** An app that may ask for access. Confidential (it has a secret): the exchange of the code happens on its server. */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** The public identifier the app sends (not a secret). */
  clientId: varchar("client_id", { length: 64 }).notNull().unique(),
  secretHash: varchar("secret_hash", { length: 64 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  /** Compared EXACTLY (no wildcards, no prefixes). */
  redirectUris: text("redirect_uris").array().notNull(),
  scopes: text("scopes").array().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The connection of one person with one app, from the moment the person authorizes until they (or the app) revoke it. */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("oauth_grants_user_idx").on(table.userId)],
);

/** What the person approved, waiting to be exchanged: one use, ten minutes, tied to the person, the app, the address and the PKCE challenge. */
export const oauthCodes = pgTable("oauth_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeHash: varchar("code_hash", { length: 64 }).notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
  scope: varchar("scope", { length: 200 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The connection this code produced: if the code is presented again, that connection is revoked. */
  grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One pair of tokens. Using the refresh token marks the row as used and creates the next pair in the same connection (a chain): presenting a
 * refresh token that was already used means it was copied, and the whole connection is revoked.
 */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    accessHash: varchar("access_hash", { length: 64 }).notNull().unique(),
    refreshHash: varchar("refresh_hash", { length: 64 }).notNull().unique(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    /** The refresh token was exchanged for the next pair. */
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("oauth_tokens_grant_idx").on(table.grantId)],
);

/** Who authorized, renewed or revoked what. Never holds a secret, a code or a token. */
export const oauthAuditLog = pgTable(
  "oauth_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** authorize | deny | token_issued | refresh | revoke | reuse_detected */
    event: varchar("event", { length: 30 }).notNull(),
    userId: uuid("user_id"),
    clientId: varchar("client_id", { length: 64 }),
    detail: varchar("detail", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("oauth_audit_user_idx").on(table.userId, table.createdAt)],
);

export type OauthClient = typeof oauthClients.$inferSelect;
export type OauthGrant = typeof oauthGrants.$inferSelect;
