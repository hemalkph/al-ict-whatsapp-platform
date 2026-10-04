import { bigint, index, integer, pgTable, text, boolean, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, tz, updatedAt } from "./_shared";

// BETTER AUTH-OWNED TABLES (better-auth / @better-auth/drizzle-adapter 1.7.7).
//
// The shape of these five tables is dictated by the library. Property names (and therefore the
// field names the adapter looks up) and column semantics must stay as the library generates them;
// only conventions are adapted: uuid PKs (advanced.database.generateId: "uuid"), timestamptz, snake_case
// index names, and DEFAULT now() on updated_at (a harmless superset of the generated schema).
//
// Required adapter wiring (see ADR 0012): model names `users`/`sessions`/`accounts`/`verifications`/
// `rate_limits` with `usePlural: false`, passing an explicit `schema` mapping because the adapter
// looks tables up by model name (`rate_limits: rateLimits`), and `drizzleAdapter(..., { transaction: true })`.
// MANDATORY: the adapter default (`transaction: false`) can leave a user without its credential account.
//
// Do NOT add application columns here (no role, no password_change_required, no plugin columns).
// Application-owned auth state lives in ./access.ts. On every Better Auth upgrade: re-run
// `npx auth@<installed version> generate` into a scratch file and diff it against this file.
// Email uniqueness is the library's plain UNIQUE(email); the library lowercases emails and our
// inputs are normalized with trim + lowercase before reaching it.

export const users = pgTable("users", {
  id: pk(),
  name: text("name").notNull(),
  email: text("email").notNull().unique("users_email_unique"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    expiresAt: tz("expires_at").notNull(),
    token: text("token").notNull().unique("sessions_token_unique"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    // Credential login: providerId = 'credential', accountId = the user's id, password = scrypt "salt:key".
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tz("access_token_expires_at"),
    refreshTokenExpiresAt: tz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: pk(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const rateLimits = pgTable("rate_limits", {
  id: pk(),
  key: text("key").notNull().unique("rate_limits_key_unique"),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
