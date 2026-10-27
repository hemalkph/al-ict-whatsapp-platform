// The two ways the browser E2E runs. Normal: the composer server (outbound queueing on) and the outbound-off server. Bots-only
// (`npm run test:e2e:bots`, E2E_MODE=bots): ONLY the outbound-off server, with every automation gate off, serves the bot specs.

type Env = Record<string, string | undefined>;

/** The effective mode. Only the harness sets it ("" or "bots"); any other value is refused rather than treated as ordinary. */
export function runMode(env: Env): "ordinary" | "bots" {
  const mode = env.E2E_MODE;
  if (mode === undefined || mode === "") return "ordinary";
  if (mode === "bots") return "bots";
  throw new Error(
    'E2E_MODE must be empty or "bots". Run with `npm run test:e2e` or `npm run test:e2e:bots`.',
  );
}

export const isBotsOnly = (env: Env): boolean => runMode(env) === "bots";

/** The control port of the server the shared helpers (navigation, teardown) must wait on. */
export function controlPortFor(env: Env): string {
  const port = env.E2E_PORT;
  const primary = env.E2E_CONTROL_PORT;
  if (isBotsOnly(env)) {
    if (!port) throw new Error("E2E_PORT is not set. Run with `npm run test:e2e:bots`.");
    return String(Number(port) + 3); // the outbound-off server's control port (playwright.config.ts)
  }
  if (!primary) throw new Error("E2E_CONTROL_PORT is not set. Run with `npm run test:e2e`.");
  return primary;
}
