import { describe, expect, it } from "vitest";
import { serverEnv } from "../e2e/support/server-env";
import { readOutboundConfig } from "../src/modules/messaging/config";

// The E2E servers must fail closed whatever the shell, CI or a `.env.local` says. Playwright merges the server env over the
// inherited environment, so "effective" below is exactly {...inherited, ...serverEnv}.

const HARNESS = {
  E2E_DATABASE_URL: "postgres://disposable/al_ict_e2e_x",
  E2E_AUTH_SECRET: "e2e-auth-secret",
  E2E_META_APP_SECRET: "e2e-meta-secret",
  E2E_WEBHOOK_VERIFY_TOKEN: "e2e-verify",
  E2E_HOST: "127.0.0.1",
  E2E_PORT: "3100",
  E2E_CONTROL_PORT: "3101",
  E2E_TLS_DIR: "/tmp/tls",
};
const hostile = {
  ...HARNESS,
  WHATSAPP_OUTBOUND_ENABLED: "true",
  WHATSAPP_LIVE_SEND_ENABLED: "true",
  WHATSAPP_BSUID_RECIPIENT_ENABLED: "true",
  WHATSAPP_ALLOW_PII_REVEAL: "true",
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_SOME_FUTURE_GATE: "true",
  WA_TOKEN_E2E_UNUSED: "EAAreal-looking-token",
  WA_TOKEN_PRODUCTION: "EAAanother",
  META_ACCESS_TOKEN: "EAAthird",
  META_APP_SECRET: "the-real-app-secret",
  DATABASE_URL: "postgres://prod.example.com/al_ict_whatsapp",
  DATABASE_URL_UNPOOLED: "postgres://prod.example.com/al_ict_whatsapp",
  TEST_DATABASE_ADMIN_URL: "postgres://prod.example.com/postgres",
  BETTER_AUTH_SECRET: "real-secret",
  BETTER_AUTH_URL: "https://real.example.com",
  BOOTSTRAP_ADMIN_PASSWORD: "x",
  INBOX_POLL_LIST_MS: "3000",
  PATH: "/usr/bin",
  NODE_ENV: "development",
};
const effective = (outboundEnabled: boolean): Record<string, string> => ({
  ...hostile,
  ...serverEnv(hostile, {
    outboundEnabled,
    baseURL: "https://127.0.0.1:3100",
    port: "3100",
    controlPort: "3101",
  }),
});

describe("E2E application servers fail closed against a hostile inherited environment", () => {
  for (const outboundEnabled of [true, false]) {
    it(`outbound queueing ${outboundEnabled ? "on" : "off"}: live sending, BSUID sending, credentials and the real database stay unreachable`, () => {
      const env = effective(outboundEnabled);
      const config = readOutboundConfig(env);
      expect(config.outboundEnabled).toBe(outboundEnabled); // the only gate that differs, and explicit
      expect(config.liveSendEnabled).toBe(false);
      expect(config.bsuidRecipientEnabled).toBe(false);
      expect(config.graphApiVersion).toBeNull(); // a live send could not even be configured
      expect(env.WHATSAPP_ALLOW_PII_REVEAL).toBe("false");
      expect(env.WA_TOKEN_E2E_UNUSED).toBe(""); // the seeded credential reference resolves to nothing
      expect(env.WA_TOKEN_PRODUCTION).toBe("");
      expect(env.META_ACCESS_TOKEN).toBe("");
      expect(env.WHATSAPP_SOME_FUTURE_GATE).toBe(""); // unknown names of the sensitive families are blanked, not inherited
      expect(env.META_APP_SECRET).toBe(HARNESS.E2E_META_APP_SECRET);
      expect(env.DATABASE_URL).toBe(HARNESS.E2E_DATABASE_URL);
      expect(env.DATABASE_URL_UNPOOLED).toBe("");
      expect(env.TEST_DATABASE_ADMIN_URL).toBe("");
      expect(env.BETTER_AUTH_SECRET).toBe(HARNESS.E2E_AUTH_SECRET);
      expect(env.BETTER_AUTH_URL).toBe("https://127.0.0.1:3100");
      expect(env.BOOTSTRAP_ADMIN_PASSWORD).toBe("");
      expect(env.INBOX_POLL_LIST_MS).toBe("");
      expect(env.NODE_ENV).toBe("production");
    });
  }

  it("a shell that sets nothing gets the same explicit gates", () => {
    const env = serverEnv(HARNESS, {
      outboundEnabled: false,
      baseURL: "https://127.0.0.1:3102",
      port: "3102",
      controlPort: "3103",
    });
    expect(env).toMatchObject({
      WHATSAPP_OUTBOUND_ENABLED: "false",
      WHATSAPP_LIVE_SEND_ENABLED: "false",
      WHATSAPP_BSUID_RECIPIENT_ENABLED: "false",
    });
  });

  it("refuses to build an environment without the harness-provided values", () => {
    expect(() =>
      serverEnv({}, { outboundEnabled: true, baseURL: "x", port: "1", controlPort: "2" }),
    ).toThrow(/E2E_DATABASE_URL/);
  });
});
