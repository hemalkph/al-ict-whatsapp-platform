import { z } from "zod";

// Meta webhook configuration, read LAZILY: importing this module (or building the app) needs neither variable. Each
// reader validates only when webhook functionality is invoked, and an error names the KEY only, never a value (a
// secret may be present but too short). No access token is read here: this milestone never calls Meta.

export type WebhookConfigKey = "META_APP_SECRET" | "WHATSAPP_WEBHOOK_VERIFY_TOKEN";

export class WebhookConfigError extends Error {
  constructor(readonly key: WebhookConfigKey) {
    super(`Missing or invalid webhook configuration: ${key}. See .env.example.`);
    this.name = "WebhookConfigError";
  }
}

type Source = Record<string, string | undefined>;

const appSecret = z.string().min(16).max(256);
const verifyToken = z.string().min(32).max(256);

function read(key: WebhookConfigKey, schema: z.ZodString, source: Source): string {
  const parsed = schema.safeParse(source[key]);
  if (!parsed.success) throw new WebhookConfigError(key);
  return parsed.data;
}

/** The Meta App Secret that signs every delivery (global to the Meta app). Never logged. */
export const readAppSecret = (source: Source = process.env): string =>
  read("META_APP_SECRET", appSecret, source);

/** The token Meta echoes in the GET verification handshake. Never logged, never returned. */
export const readVerifyToken = (source: Source = process.env): string =>
  read("WHATSAPP_WEBHOOK_VERIFY_TOKEN", verifyToken, source);
