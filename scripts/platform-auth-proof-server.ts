import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { resolveDisposableUrl, type PgTarget } from "../src/db/__tests__/helpers";

// Phase 08G-7B C1B-P1 PROOF HARNESS ONLY (started by src/modules/platform/cli-auth-proof.db.test.ts). A guarded launcher for the
// REAL Next.js production server of the E2E harness (e2e/server.mjs: Next's custom-server API over HTTPS with a throwaway
// certificate, on 127.0.0.1). Nothing is imported, connected or listened on until all of this holds, in this order:
//  1. Next's env files cannot contribute anything: every name they define, as Next's own loader parses them (envFileNames), is
//     set to "" first (Next fills only undefined names), so a developer `.env.local` cannot supply a database, PG* override,
//     credential or gate. Only key NAMES leave the listing child. After Next's preparation the checks of step 2 run again.
//  2. The effective environment passes validateProofEnvironment (no connection): production mode; no PG*, TEST_DATABASE_*, other
//     DATABASE_*, TLS-verification, NODE_OPTIONS, Graph or Meta/WhatsApp credential setting; every send/worker gate "false";
//     DATABASE_URL is a generated al_ict_test_<12 hex> database on 127.0.0.1:55432 by the harness's own driver-effective checks
//     (resolveDisposableUrl); a 64-hex binding nonce is present.
//  3. Binding evidence, on that already-validated target only: PostgreSQL 17, the database is the named one, and it holds exactly
//     one c1b_p1_proof_binding row whose SHA-256 matches the nonce, written by the harness within the last 15 minutes.
// An arbitrary DATABASE_URL is therefore never enough: the proof test creates the database, writes the binding, then starts this.

export const PROOF_HOST = "127.0.0.1";
export const PROOF_DATABASE_PORT = 55432;
export const BINDING_TABLE = "c1b_p1_proof_binding";
export const BINDING_MAX_AGE_MINUTES = 15;
const PROOF_DATABASE = /^al_ict_test_[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{64}$/;
const ROOT = join(import.meta.dirname, "..");
const FORBIDDEN = [
  /^PG[A-Z]+$/,
  /^TEST_DATABASE_/,
  /^DATABASE_(?!URL$)/,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/,
  /^NODE_OPTIONS$/,
  /^(WA_|META_ACCESS|GRAPH_|BOOTSTRAP_)/,
  /^WHATSAPP_GRAPH_API_VERSION$/,
];
const GATES_OFF = [
  "WHATSAPP_OUTBOUND_ENABLED",
  "WHATSAPP_LIVE_SEND_ENABLED",
  "WHATSAPP_WORKER_ENABLED",
  "BOTS_RUNTIME_ENABLED",
];

export class ProofRefused extends Error {}
const refuse = (reason: string): never => {
  throw new ProofRefused(reason);
};

type Env = Record<string, string | undefined>;

// Next's OWN loader (the @next/env that the installed `next` resolves), run in a child with an EMPTY environment, so every name
// any of its env files defines is reported: the bundled dotenv grammar (KEY=value, KEY: value, `export`, quoted and multi-line
// values, [\w.-] names) and Next's production file order. Only the names leave the child; values stay in its memory.
const LIST_ENV_FILE_NAMES = `
const { createRequire } = require("node:module");
const nextRequire = createRequire(require.resolve("next/package.json", { paths: [process.cwd()] }));
const { loadEnvConfig } = nextRequire("@next/env");
const { parsedEnv } = loadEnvConfig(process.cwd(), false, { info() {}, error() {} }, true);
process.stdout.write(JSON.stringify(Object.keys(parsedEnv || {})));
`;
const ENV_NAME = /^[\w.-]+$/; // the bundled dotenv key grammar

/** The variable NAMES Next's env files in `dir` define, as Next itself parses them (values never leave the child). */
export function envFileNames(dir = ROOT): string[] {
  const res = spawnSync(process.execPath, ["-e", LIST_ENV_FILE_NAMES], {
    cwd: dir,
    // no NODE_ENV: Next's production mode, like the server; nothing inherited, so nothing is pre-defined
    env: {} as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  let names: unknown;
  try {
    names = JSON.parse(res.stdout);
  } catch {
    names = undefined;
  }
  if (
    res.status !== 0 ||
    !Array.isArray(names) ||
    !names.every((n) => typeof n === "string" && ENV_NAME.test(n))
  )
    refuse("Next's env files could not be listed"); // fail closed: they would otherwise load unchecked
  return names as string[];
}

/** Next applies an env-file value only to a name that is undefined at its first load: define each as "". */
export function neutralizeEnvFiles(env: Env, names: readonly string[]): void {
  for (const name of names) if (env[name] === undefined) env[name] = "";
}

/** Parsing only: the target the server may use, or ProofRefused. Opens nothing. */
export function validateProofEnvironment(env: Env): { target: PgTarget; nonce: string } {
  if (env.NODE_ENV !== "production") refuse("NODE_ENV must be production");
  for (const [name, value] of Object.entries(env))
    if (value && FORBIDDEN.some((pattern) => pattern.test(name))) refuse(`${name} must not be set`);
  for (const gate of GATES_OFF) if (env[gate] !== "false") refuse(`${gate} must be "false"`);
  if (env.E2E_HOST !== PROOF_HOST) refuse(`E2E_HOST must be ${PROOF_HOST}`);
  if (!/^[1-9][0-9]{0,4}$/.test(env.E2E_PORT ?? "")) refuse("E2E_PORT is invalid");
  if (env.BETTER_AUTH_URL !== `https://${PROOF_HOST}:${env.E2E_PORT}`)
    refuse("BETTER_AUTH_URL must be the proof server's own https origin");
  const nonce = env.PROOF_BINDING_NONCE ?? "";
  if (!NONCE.test(nonce)) refuse("the proof-harness binding nonce is missing or malformed");
  let target: PgTarget | undefined;
  try {
    target = resolveDisposableUrl(env.DATABASE_URL);
  } catch {
    refuse("DATABASE_URL is not a valid disposable database URL"); // the harness reason could quote the input
  }
  if (
    target!.host !== PROOF_HOST ||
    target!.port !== PROOF_DATABASE_PORT ||
    !PROOF_DATABASE.test(target!.database)
  )
    refuse(
      `DATABASE_URL must name a generated al_ict_test_* database on ${PROOF_HOST}:${PROOF_DATABASE_PORT}`,
    );
  return { target: target!, nonce };
}

/** On the validated target only: PostgreSQL 17, the named database, and this run's fresh binding row. */
export async function verifyBinding(target: PgTarget, nonce: string): Promise<void> {
  const client = new Client({ ...target, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ db: string; v: number; n: number; bound: boolean }>(
      `select current_database() db, current_setting('server_version_num')::int v,
              (select count(*)::int from ${BINDING_TABLE}) n,
              exists (select 1 from ${BINDING_TABLE} where nonce_sha256 = $1 and created_at <= clock_timestamp()
                      and created_at > clock_timestamp() - make_interval(mins => $2)) bound`,
      [createHash("sha256").update(nonce).digest("hex"), BINDING_MAX_AGE_MINUTES],
    );
    const r = rows[0];
    if (!r || r.db !== target.database || r.v < 170000 || r.v >= 180000 || r.n !== 1 || !r.bound)
      refuse("the database carries no matching, fresh proof-harness binding");
  } catch (error) {
    if (error instanceof ProofRefused) throw error;
    refuse("the proof-harness binding could not be verified");
  } finally {
    await client.end().catch(() => undefined);
  }
}

export type LaunchDeps = {
  readonly envFileNames: () => readonly string[];
  readonly verifyBinding: (target: PgTarget, nonce: string) => Promise<void>;
  readonly start: () => Promise<void>;
};

export async function launch(env: Env, deps: LaunchDeps): Promise<void> {
  neutralizeEnvFiles(env, deps.envFileNames());
  const { target, nonce } = validateProofEnvironment(env);
  await deps.verifyBinding(target, nonce);
  await deps.start();
}

async function startNextServer(): Promise<void> {
  // Any outbound HTTP attempt from the application would be a scope violation: refuse it loudly.
  globalThis.fetch = () => {
    console.error("PROOF_OUTBOUND_FETCH_BLOCKED");
    return Promise.reject(new Error("outbound fetch blocked in the C1B-P1 proof server"));
  };
  // e2e/server.mjs awaits Next's preparation (which applies its env files) before it calls listen().
  await import(pathToFileURL(join(ROOT, "e2e/server.mjs")).href);
  // The environment Next actually ended up with: the same checks again, before any request can reach the application (the
  // database is opened lazily, on the first request). Exit at once if Next's preparation changed anything that matters.
  try {
    validateProofEnvironment(process.env);
  } catch (error) {
    console.error(
      `PROOF_SERVER_REFUSED: after Next preparation: ${error instanceof ProofRefused ? error.message : "check failed"}`,
    );
    process.exit(1);
  }
  console.log("PROOF_ENV_VERIFIED_AFTER_NEXT_PREPARE");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launch(process.env, { envFileNames, verifyBinding, start: startNextServer }).catch(
    (error: unknown) => {
      console.error(
        `PROOF_SERVER_REFUSED: ${error instanceof ProofRefused ? error.message : "startup failed"}`,
      );
      process.exit(1);
    },
  );
}
