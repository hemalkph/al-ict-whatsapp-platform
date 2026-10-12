// The environment of the two E2E application servers (see playwright.config.ts).
//
// Playwright merges a web server's `env` OVER the environment it inherited, and Next additionally loads `.env*` files for names
// the process does not define. So any gate or credential that is not set here would come from the developer's shell, CI, or a
// `.env.local`. Nothing the E2E servers do may depend on that: every setting that decides whether the application could send, or
// reach anything outside the disposable database, is set explicitly, and any other name from the families that could matter is
// blanked. A blank value counts as "not set" to the application and still shadows a `.env.local`.
//
// The E2E servers may QUEUE outbound messages when `outboundEnabled` is true (the inbox composer needs it). They can never SEND:
// there is no outbound worker, the live-send gate is explicitly false, and no Meta credential or Graph version exists.

export type ServerEnvOptions = {
  /** Staff may queue replies on this server. The second server (the "switched off" state) passes false. */
  outboundEnabled: boolean;
  baseURL: string;
  port: string;
  controlPort: string;
};

/** Families of names that could change what the server may do or reach; blanked unless set explicitly below. */
const SCRUBBED_FAMILIES =
  /^(WHATSAPP_|META_|WA_|GRAPH_|DATABASE_|TEST_DATABASE_|BOOTSTRAP_|BETTER_AUTH_)/;

type Source = Record<string, string | undefined>;

const required = (source: Source, name: string): string => {
  const value = source[name];
  if (!value)
    throw new Error(`${name} is not set. Run the browser tests with \`npm run test:e2e\`.`);
  return value;
};

export function serverEnv(source: Source, options: ServerEnvOptions): Record<string, string> {
  const explicit: Record<string, string> = {
    NODE_ENV: "production",
    // the disposable database created for this run, never an inherited DATABASE_URL
    DATABASE_URL: required(source, "E2E_DATABASE_URL"),
    BETTER_AUTH_SECRET: required(source, "E2E_AUTH_SECRET"),
    BETTER_AUTH_URL: options.baseURL,
    // fake, run-only values
    META_APP_SECRET: required(source, "E2E_META_APP_SECRET"),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: required(source, "E2E_WEBHOOK_VERIFY_TOKEN"),
    // the gates: each one explicit, none inherited
    WHATSAPP_OUTBOUND_ENABLED: options.outboundEnabled ? "true" : "false",
    WHATSAPP_LIVE_SEND_ENABLED: "false",
    WHATSAPP_BSUID_RECIPIENT_ENABLED: "false",
    WHATSAPP_ALLOW_PII_REVEAL: "false",
    // no Graph version and no token for the one credential reference the seed uses (a live send could not even be configured)
    WHATSAPP_GRAPH_API_VERSION: "",
    WA_TOKEN_E2E_UNUSED: "",
    // default polling, whatever the shell says
    INBOX_POLL_LIST_MS: "",
    INBOX_POLL_CHAT_MS: "",
    E2E_HOST: required(source, "E2E_HOST"),
    E2E_PORT: options.port,
    E2E_CONTROL_PORT: options.controlPort,
    E2E_TLS_DIR: required(source, "E2E_TLS_DIR"),
  };
  const blanked: Record<string, string> = {};
  for (const name of Object.keys(source))
    if (SCRUBBED_FAMILIES.test(name) && !(name in explicit)) blanked[name] = "";
  return { ...blanked, ...explicit };
}
