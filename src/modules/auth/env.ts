import { z } from "zod";

// Auth environment is read and validated ONLY when an auth instance is actually created (lazy), so importing
// application modules and building the app never requires these variables.

export type AuthEnv = {
  /** Better Auth signing/encryption secret (>= 32 chars). Never logged. */
  readonly secret: string;
  /** Public base URL of the app, e.g. https://app.example.com. */
  readonly baseURL: string;
  /** Exact origin derived from baseURL; the only trusted origin. */
  readonly origin: string;
};

const schema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
});

export function readAuthEnv(
  source: Record<string, string | undefined> = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): AuthEnv {
  const parsed = schema.safeParse({
    BETTER_AUTH_SECRET: source.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: source.BETTER_AUTH_URL,
  });
  if (!parsed.success) {
    // Names only: never echo values (a secret may be present but too short).
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new Error(`Invalid or missing auth configuration: ${names}. See .env.example.`);
  }
  const url = new URL(parsed.data.BETTER_AUTH_URL);
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use https in production.");
  }
  return {
    secret: parsed.data.BETTER_AUTH_SECRET,
    baseURL: url.origin + url.pathname.replace(/\/$/, ""),
    origin: url.origin,
  };
}
