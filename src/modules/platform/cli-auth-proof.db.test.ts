import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { createTestDatabase, seedOrg, type TestDb } from "@/db/__tests__/helpers";
import { PASSWORD, provisionUser, realAuth, type RealAuth } from "@/db/__tests__/real-auth";
import { serverEnv } from "../../../e2e/support/server-env";
import {
  RECOVERY,
  SIGN_OUT_MESSAGES,
  createOperatorClient,
  describeSignIn,
  httpsJson,
  main,
  type JsonResponse,
} from "../../../scripts/platform-auth-proof";
import { BINDING_TABLE, envFileNames } from "../../../scripts/platform-auth-proof-server";
import { bootstrapPlatformSecurityAdmin } from "./bootstrap";

// Phase 08G-7B C1B-P1 (plan section 10) through the REAL Next.js production pipeline: `next build`, then the E2E harness's
// e2e/server.mjs (Next's custom-server API) behind the guarded launcher scripts/platform-auth-proof-server.ts. Topology:
//   client --verified TLS--> node:https on 127.0.0.1 (throwaway certificate) --> Next request handler (proxy.ts, routing,
//   x-forwarded-for ??= socket address) --> the mounted route handlers --> generated al_ict_test_* database.
// No reverse proxy: whatever header the client sends reaches Next unchanged. Since C1B-P3 the application reads the client IP
// only from CF-Connecting-IP and refuses auth requests without it, so the harness plays the trusted ingress and sets that header
// itself. That proves the application's handling; it cannot prove spoof resistance (no Cloudflare here). Synthetic users only.
// Opt-in, because it
// builds the application (minutes) and requires the isolated server on 127.0.0.1:55432:
//   C1B_P1_PROOF=1 TEST_DATABASE_ADMIN_URL=... npx vitest run --config vitest.db.config.mts src/modules/platform/cli-auth-proof.db.test.ts

const AUTH_SECRET = "c1b-p1-proof-only-secret-".padEnd(48, "x"); // meaningless outside the disposable database
const CANARY = "c1b-p1-canary-must-never-be-logged";
const NEW_PASSWORD = "c1b-p1-replaced-password-97531";
const WRONG = "wrong-password-123456";
const SESSION_COOKIE = "__Secure-better-auth.session_token";
const ROOT = join(import.meta.dirname, "../../..");
const PROOF_SOURCES = new Set([
  "scripts/platform-auth-proof.ts",
  "scripts/platform-auth-proof.test.ts",
  "scripts/platform-auth-proof-server.ts",
  "src/modules/platform/cli-auth-proof.db.test.ts",
  // defines the synthetic PASSWORD this proof imports; it shows up as "modified" whenever it has uncommitted edits (C1B-P3)
  "src/db/__tests__/real-auth.ts",
]);
let n = 0;
const email = (label: string) => `${label}.${Date.now().toString(36)}${n++}@c1b-p1.example.test`;
let ipCounter = 0;
/** A distinct synthetic client IP: one limiter bucket per case (the limiter is the subject of P1-T4..T6 only). */
const ip = () => `198.18.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

const freePort = () =>
  new Promise<string>((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(String(port)));
    });
  });

/** Runs the launcher to completion and returns its exit code and output (for startup refusals). */
const runLauncher = (env: Record<string, string>) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/platform-auth-proof-server.ts"],
      { cwd: ROOT, env: env as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.on("exit", (code) => resolve({ code, output }));
  });

describe.skipIf(process.env.C1B_P1_PROOF !== "1")(
  "C1B-P1 non-browser CLI authentication proof (real Next.js production server, Better Auth and PostgreSQL)",
  () => {
    let t: TestDb;
    let a: RealAuth;
    let tlsDir: string;
    let ca: Buffer;
    let origin: string;
    let server: ChildProcess;
    let launchEnv: Record<string, string>;
    const serverLog: string[] = [];
    const startedAt = Date.now();
    let orgId: string;
    let sa1: { id: string; email: string; grantId: string };

    beforeAll(async () => {
      t = await createTestDatabase();
      a = realAuth(t);
      orgId = (await seedOrg(t.db)).id;
      // Test-only record of every session token ever issued, so outputs and files can be scanned for them (P1-T17).
      await t.pool.query(`
      create table proof_seen_tokens (token text not null);
      create function proof_seen_token() returns trigger language plpgsql as $$
        begin insert into proof_seen_tokens values (NEW.token); return NEW; end $$;
      create trigger proof_seen_token_trg after insert on sessions for each row execute function proof_seen_token();`);

      tlsDir = mkdtempSync(join(tmpdir(), "al-ict-c1b-p1-tls-"));
      ca = makeCertificate(tlsDir, "key.pem", "cert.pem");
      const [port, controlPort] = [await freePort(), await freePort()];
      origin = `https://127.0.0.1:${port}`;
      // An explicit allowlist (nothing inherited: no TEST_DATABASE_ADMIN_URL, PG*, Meta/WhatsApp names). serverEnv is the E2E
      // harness's own server environment (gates off, no Graph version or token); every name Next's env files define is blanked.
      const blankedEnvFiles = Object.fromEntries(envFileNames().map((name) => [name, ""]));
      const appEnv = {
        ...blankedEnvFiles,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        NEXT_TELEMETRY_DISABLED: "1",
        ...serverEnv(
          {
            E2E_DATABASE_URL: t.url,
            E2E_AUTH_SECRET: AUTH_SECRET,
            E2E_META_APP_SECRET: "c1b-p1-unused-meta-app-secret",
            E2E_WEBHOOK_VERIFY_TOKEN: "c1b-p1-unused-verify-token",
            E2E_HOST: "127.0.0.1",
            E2E_TLS_DIR: tlsDir,
          },
          { outboundEnabled: false, baseURL: origin, port, controlPort },
        ),
      };
      const build = spawnSync("npx", ["next", "build"], {
        cwd: ROOT,
        env: appEnv as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 900_000,
      });
      if (build.status !== 0)
        throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

      // The binding the launcher requires: this run's nonce, written just now into this database only.
      const nonce = randomBytes(32).toString("hex");
      await t.pool.query(
        `create table ${BINDING_TABLE} (nonce_sha256 text primary key, created_at timestamptz not null default clock_timestamp());
       insert into ${BINDING_TABLE} (nonce_sha256) values ('${createHash("sha256").update(nonce).digest("hex")}');`,
      );
      launchEnv = { ...appEnv, PROOF_BINDING_NONCE: nonce };
      server = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/platform-auth-proof-server.ts"],
        {
          cwd: ROOT,
          env: launchEnv as unknown as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`proof server did not start:\n${serverLog.join("")}`)),
          120_000,
        );
        const onData = (c: Buffer) => {
          serverLog.push(c.toString());
          const all = serverLog.join("");
          // Ready only once Next listens AND the launcher re-checked the environment Next's preparation produced.
          if (
            all.includes(`E2E server ready on ${origin}`) &&
            all.includes("PROOF_ENV_VERIFIED_AFTER_NEXT_PREPARE")
          ) {
            clearTimeout(timer);
            resolve();
          }
        };
        server.stdout!.on("data", onData);
        server.stderr!.on("data", onData);
        server.on("exit", (code) =>
          reject(new Error(`proof server exited (${code}):\n${serverLog.join("")}`)),
        );
      });

      const e1 = email("sa1");
      const u1 = await provisionUser(a, t, e1);
      const boot = await bootstrapPlatformSecurityAdmin(
        { email: e1, password: PASSWORD, verificationRef: "C1B-P1-BOOT" },
        { db: t.db },
      );
      sa1 = { id: u1.id, email: e1, grantId: boot.grantId };
    }, 1_200_000);

    afterAll(async () => {
      if (server && server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        await exited;
      }
      if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
      await t?.close();
    });

    // ------------------------------------------------------------------------------------------ helpers
    function makeCertificate(dir: string, key: string, cert: string): Buffer {
      const res = spawnSync(
        "openssl",
        [
          ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
          ...["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
          ...["-keyout", join(dir, key), "-out", join(dir, cert)],
        ],
        { env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, stdio: "ignore" },
      );
      if (res.status !== 0) throw new Error("openssl could not create a throwaway certificate");
      return readFileSync(join(dir, cert));
    }
    /** Every request needs the synthetic ingress header (C1B-P3): its own address unless the case supplies one. */
    const raw = (init: Parameters<typeof httpsJson>[1]) =>
      httpsJson(
        { origin, ca },
        { ...init, headers: { "cf-connecting-ip": ip(), ...init.headers } },
      );
    /** A POST with exactly these headers (httpsJson always sets Origin; this can omit or replace it). Verified TLS. */
    const bare = (path: string, headers: Record<string, string>, body: unknown) =>
      new Promise<{ status: number; setCookies: string[] }>((resolve, reject) => {
        const url = new URL(path, origin);
        const req = httpsRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            ca,
            agent: false,
            headers: { "content-type": "application/json", ...headers },
          },
          (r) => {
            r.resume();
            r.on("end", () =>
              resolve({ status: r.statusCode ?? 0, setCookies: r.headers["set-cookie"] ?? [] }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    const client = () =>
      createOperatorClient({ baseUrl: origin, ca, extraHeaders: { "cf-connecting-ip": ip() } });
    const signInRaw = (
      e: string,
      password = PASSWORD,
      headers: Record<string, string> = { "cf-connecting-ip": ip() },
    ) =>
      raw({
        method: "POST",
        path: "/api/auth/sign-in/email",
        body: { email: e, password, rememberMe: false },
        headers,
      });
    const cookieOf = (res: { setCookies: string[] }) =>
      res.setCookies.map((c) => c.split(";")[0]).join("; ");
    const signOutRaw = (res: { setCookies: string[] }) =>
      raw({ method: "POST", path: "/api/auth/sign-out", body: {}, cookie: cookieOf(res) });
    const code = (res: JsonResponse) =>
      (res.json as { error?: { code?: string }; code?: string } | undefined)?.error?.code ??
      (res.json as { code?: string } | undefined)?.code;
    const sessionsOf = async (userId: string) =>
      (await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).length;
    /** Fixture reset between cases: deleting sessions only ever removes authority. */
    const resetSessions = (userId: string) =>
      t.pool.query("delete from sessions where user_id = $1", [userId]);
    /** The CLI itself sends no client-IP header (the ingress adds it in production); the harness plays the ingress for it. */
    const CLI_IP = "198.18.255.254";
    const resetPeerBucket = () =>
      t.pool.query("delete from rate_limits where key = $1", [`${CLI_IP}|/sign-in/email`]);
    const grantBody = (target: string, role = "PLATFORM_OPERATOR") => ({
      email: target,
      role,
      verificationRef: "C1B-P1-V",
    });

    /** A signed-in client for `e`, asserting success. */
    async function signedIn(e: string, password = PASSWORD) {
      const c = client();
      expect(await c.signIn(e, password)).toEqual({ ok: true, previousSession: "NO_SESSION" });
      return c;
    }
    /** A new user granted `role` by sa1 through the real route (sa1 freshly authenticated). */
    async function operator(
      role: "PLATFORM_OPERATOR" | "PLATFORM_SECURITY_ADMIN" = "PLATFORM_OPERATOR",
    ) {
      const e = email(role === "PLATFORM_OPERATOR" ? "op" : "sa");
      const u = await provisionUser(a, t, e);
      const admin = await signedIn(sa1.email);
      const res = await admin.post("/api/platform/operators", grantBody(e, role));
      expect(res.status).toBe(201);
      expect(await admin.signOut()).toBe("CONFIRMED");
      return { id: u.id, email: e, grantId: (res.json as { grantId: string }).grantId };
    }
    /**
     * Moves a user's password-verification time (and created_at) BACKWARDS, to make a session stale: the C1A technique (migration
     * 0010 keeps both immutable, so it runs with triggers off, as only a privileged credential holder could). Used only to cause a
     * refusal; success always comes from a real sign-in.
     */
    async function ageSessions(userId: string, minutes: number) {
      const c = await t.pool.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        await c.query(
          "update sessions set created_at = clock_timestamp() - make_interval(mins => $2), credential_verified_at = clock_timestamp() - make_interval(mins => $2) where user_id = $1",
          [userId, minutes],
        );
        await c.query("commit");
      } finally {
        c.release();
      }
    }
    async function waitForLockWaiters(count: number) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await t.pool.query(
          "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (res.rows[0].n >= count) return;
        if (Date.now() > deadline) throw new Error(`expected ${count} lock waiter(s)`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // ------------------------------------------------------------------------------------------ P1-T1
    it("P1-T1 valid non-browser HTTPS sign-in, an authenticated platform read, and a confirmed sign-out", async () => {
      const c = await signedIn(sa1.email);
      expect(c.userId).toBe(sa1.id);
      const read = await c.get("/api/platform/audit?limit=1");
      expect(read.status).toBe(200);
      expect((read.json as { scope: string }).scope).toBe("all");
      expect(await c.signOut()).toBe("CONFIRMED");
      expect(c.hasSession()).toBe(false);
      expect(c.userId).toBeNull();
      expect(await sessionsOf(sa1.id)).toBe(0);
    });

    // ------------------------------------------------------------------------------------------ P1-T2
    describe("P1-T2 Origin and CSRF", () => {
      it("cookieless sign-in: the configured origin is accepted; foreign, null, http-scheme, other-port, cross-site navigation and a foreign callbackURL are refused", async () => {
        const ok = await signInRaw(sa1.email);
        expect(ok.status).toBe(200);
        await signOutRaw(ok);
        for (const bad of [
          "https://evil.example",
          "null",
          origin.replace("https:", "http:"),
          "https://127.0.0.1:1",
        ]) {
          const res = await bare(
            "/api/auth/sign-in/email",
            { origin: bad, "cf-connecting-ip": ip() },
            { email: sa1.email, password: PASSWORD },
          );
          expect(res.status, bad).toBe(403);
          expect(res.setCookies).toEqual([]);
        }
        const nav = await bare(
          "/api/auth/sign-in/email",
          {
            "cf-connecting-ip": ip(),
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
          { email: sa1.email, password: PASSWORD },
        );
        expect(nav.status).toBe(403);
        const cb = await raw({
          method: "POST",
          path: "/api/auth/sign-in/email",
          body: { email: sa1.email, password: PASSWORD, callbackURL: "https://evil.example/steal" },
          headers: { "cf-connecting-ip": ip() },
        });
        expect(cb.status).toBe(403);
        expect(cb.setCookies).toEqual([]);
        expect(await sessionsOf(sa1.id)).toBe(0);
      });

      it("FINDING: a cookieless sign-in with no Origin, Referer or Fetch-Metadata is accepted (checked only when present)", async () => {
        const res = await bare(
          "/api/auth/sign-in/email",
          { "cf-connecting-ip": ip() },
          { email: sa1.email, password: PASSWORD },
        );
        expect(res.status).toBe(200);
        await signOutRaw(res);
      });

      it("cookie-bearing mutations need the exact origin: Better Auth sign-out and the application's platform route", async () => {
        const session = await signInRaw(sa1.email);
        const cookie = cookieOf(session);
        const target = email("t2");
        await provisionUser(a, t, target);
        for (const bad of [
          undefined,
          "null",
          "https://evil.example",
          origin.replace("https:", "http:"),
        ]) {
          const headers: Record<string, string> = { cookie, "cf-connecting-ip": ip() };
          if (bad !== undefined) headers.origin = bad;
          expect((await bare("/api/auth/sign-out", headers, {})).status, `sign-out ${bad}`).toBe(
            403,
          );
          expect(
            (await bare("/api/platform/operators", headers, grantBody(target))).status,
            `grant ${bad}`,
          ).toBe(403);
        }
        // A foreign Referer cannot stand in for a missing Origin.
        expect(
          (
            await bare(
              "/api/auth/sign-out",
              { cookie, referer: "https://evil.example/x", "cf-connecting-ip": ip() },
              {},
            )
          ).status,
        ).toBe(403);
        expect(await sessionsOf(sa1.id)).toBe(1); // none of the refused sign-outs removed it
        const granted = await t.pool.query(
          "select count(*)::int n from platform_operator_roles r join users u on u.id = r.user_id where u.email = $1",
          [target],
        );
        expect(granted.rows[0].n).toBe(0);
        expect((await signOutRaw(session)).status).toBe(200);
      });

      it("the client refuses an http base URL; TLS verification refuses an unrelated CA and a host-name mismatch", async () => {
        expect(() =>
          createOperatorClient({ baseUrl: origin.replace("https:", "http:"), ca }),
        ).toThrow(/https/);
        const other = mkdtempSync(join(tmpdir(), "al-ict-c1b-p1-other-"));
        try {
          const wrongCa = createOperatorClient({
            baseUrl: origin,
            ca: makeCertificate(other, "k.pem", "c.pem"),
          });
          await expect(wrongCa.signIn(sa1.email, PASSWORD)).rejects.toThrow(
            /self[- ]signed|unable to verify|certificate/i,
          );
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
        const wrongHost = createOperatorClient({
          baseUrl: origin.replace("127.0.0.1", "localhost"),
          ca,
        });
        await expect(wrongHost.signIn(sa1.email, PASSWORD)).rejects.toThrow(
          /altnames|does not match|certificate/i,
        );
        expect(await sessionsOf(sa1.id)).toBe(0); // no request reached the application
      });
    });

    // ------------------------------------------------------------------------------------------ P1-T3
    it("P1-T3 cookie attributes, several Set-Cookie headers, replacement, deletion and memory-only handling", async () => {
      await resetSessions(sa1.id);
      const res = await signInRaw(sa1.email);
      expect(res.status).toBe(200);
      expect(res.setCookies.length).toBeGreaterThanOrEqual(2); // session token + dont_remember (rememberMe false)
      for (const line of res.setCookies) {
        expect(line).toMatch(/^__Secure-better-auth\./);
        expect(line).toMatch(/;\s*Secure/i);
        expect(line).toMatch(/;\s*HttpOnly/i);
        expect(line).toMatch(/;\s*SameSite=Lax/i);
        expect(line).toMatch(/;\s*Path=\//i);
        expect(line).not.toMatch(/;\s*Domain=/i); // host-only
        expect(line).not.toMatch(/;\s*(Max-Age|Expires)=/i); // rememberMe false: a browser-session cookie
      }
      await signOutRaw(res);

      const c = await signedIn(sa1.email);
      expect(c.cookies().map((x) => x.name)).toContain(SESSION_COOKIE);
      expect(
        c.cookies().every((x) => x.secure && x.httpOnly && x.sameSite === "lax" && !x.persistent),
      ).toBe(true);
      // Server-side the session keeps an expiry even with rememberMe false: it does not end with the process.
      const [row] = await t.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, sa1.id));
      const hours = (row!.expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1);
      // Re-authentication replaces the cookie; the previous server session is signed out.
      const ids = async () =>
        (await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, sa1.id))).map(
          (s) => s.id,
        );
      const before = await ids();
      expect(await c.signIn(sa1.email, PASSWORD)).toEqual({
        ok: true,
        previousSession: "CONFIRMED",
      });
      const after = await ids();
      expect(after).toHaveLength(1);
      expect(before).not.toContain(after[0]);
      expect(await c.signOut()).toBe("CONFIRMED");
      expect(c.cookies()).toEqual([]);
    });

    // ------------------------------------------------------------------------------------------ P1-T4 / T5 / T6
    describe("P1-T4..T6 sign-in rate limiting (customRules /sign-in/email: 5 per 60 s, database storage)", () => {
      it("P1-T4 invalid credentials are 401 without enumeration; the sixth attempt in the window is 429 even with the right password", async () => {
        const unknown = await signInRaw(email("nobody"), PASSWORD);
        const wrong = await signInRaw(sa1.email, WRONG);
        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(code(unknown)).toBe(code(wrong));
        const bucket = { "cf-connecting-ip": ip() };
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++)
          statuses.push((await signInRaw(sa1.email, WRONG, bucket)).status);
        const sixth = await signInRaw(sa1.email, PASSWORD, bucket);
        expect(statuses).toEqual([401, 401, 401, 401, 401]);
        expect(sixth.status).toBe(429);
        expect(sixth.setCookies).toEqual([]);
      });

      it("P1-T5 twelve concurrent attempts from one client IP: exactly five are evaluated, seven are 429", async () => {
        const bucket = { "cf-connecting-ip": ip() };
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            signInRaw(sa1.email, i % 2 ? PASSWORD : WRONG, bucket),
          ),
        );
        const statuses = results.map((r) => r.status);
        expect(statuses.filter((s) => s === 429)).toHaveLength(7);
        expect(statuses.filter((s) => s !== 429)).toHaveLength(5);
        for (const r of results.filter((x) => x.status === 200)) await signOutRaw(r);
      });

      it("P1-T6 (C1B-P3) a client-chosen X-Forwarded-For, X-Real-IP or Forwarded no longer selects the bucket", async () => {
        // The P1 finding (a fresh bucket per forged X-Forwarded-For value), closed in application code: only CF-Connecting-IP
        // is read. Whether a client can forge THAT header is decided by the ingress, which this topology does not contain.
        const trusted = ip();
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++)
          statuses.push(
            (
              await signInRaw(sa1.email, WRONG, {
                "cf-connecting-ip": trusted,
                "x-forwarded-for": ip(),
                "x-real-ip": ip(),
                forwarded: `for=${ip()}`,
              })
            ).status,
          );
        expect(statuses).toEqual([...Array(5).fill(401), ...Array(7).fill(429)]);
        const row = await t.pool.query("select count from rate_limits where key = $1", [
          `${trusted}|/sign-in/email`,
        ]);
        expect(row.rows[0].count).toBe(5);
      });

      it("P1-T6 (C1B-P3) a missing or malformed CF-Connecting-IP is refused (403) and never reaches a shared bucket", async () => {
        // Before C1B-P3 these resolved to "no IP" and the shared `no-trusted-ip|/sign-in/email` bucket, which five unrelated
        // senders could exhaust for everyone. Next still adds x-forwarded-for from the socket; it is no longer read.
        await t.pool.query(
          "delete from rate_limits where key in ('no-trusted-ip|/sign-in/email', '127.0.0.1|/sign-in/email')",
        );
        const senders: Array<Record<string, string>> = [
          {},
          { "x-forwarded-for": "203.0.113.1" },
          { "cf-connecting-ip": "203.0.113.1, 10.0.0.1" },
          { "cf-connecting-ip": "not-an-ip" },
          { "cf-connecting-ip": "unknown", "x-forwarded-for": "198.51.100.7" },
          { "cf-connecting-ip": "::ffff:zz" },
          { "cf-connecting-ip": "203.0.113.1:443" },
        ];
        for (const headers of senders) {
          const res = await bare(
            "/api/auth/sign-in/email",
            { origin, ...headers },
            { email: sa1.email, password: PASSWORD }, // the CORRECT password
          );
          expect(res.status, JSON.stringify(headers)).toBe(403);
          expect(res.setCookies).toEqual([]);
        }
        const rows = await t.pool.query(
          "select key from rate_limits where key in ('no-trusted-ip|/sign-in/email', '127.0.0.1|/sign-in/email')",
        );
        expect(rows.rows).toEqual([]);
        const ok = await signInRaw(sa1.email); // a sender with a trusted address is unaffected
        expect(ok.status).toBe(200);
        await signOutRaw(ok);
      });
    });

    // ------------------------------------------------------------------------------------------ P1-T7 / T8 / T9
    it("P1-T7..T9 recent authentication allows a mutation; an expired window refuses it; a normal sign-in restores it", async () => {
      await resetSessions(sa1.id);
      const admin = await signedIn(sa1.email);
      const [row] = await t.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, sa1.id));
      expect(row!.credentialVerifiedAt).toBeInstanceOf(Date); // stamped by the session-create hook from the database clock
      expect(Math.abs(row!.credentialVerifiedAt!.getTime() - Date.now())).toBeLessThan(60_000);
      const t1 = email("t7");
      await provisionUser(a, t, t1);
      expect((await admin.post("/api/platform/operators", grantBody(t1))).status).toBe(201); // T7

      await ageSessions(sa1.id, 11);
      const t2 = email("t8");
      await provisionUser(a, t, t2);
      const stale = await admin.post("/api/platform/operators", grantBody(t2));
      expect(stale.status).toBe(403); // T8
      expect(code(stale)).toBe("REAUTHENTICATION_REQUIRED");
      expect((await admin.get("/api/platform/operators")).status).toBe(200); // reads still work

      expect(await admin.signIn(sa1.email, PASSWORD)).toEqual({
        ok: true,
        previousSession: "CONFIRMED",
      }); // T9: the ordinary public sign-in
      expect((await admin.post("/api/platform/operators", grantBody(t2))).status).toBe(201);
      expect(await sessionsOf(sa1.id)).toBe(1); // the stale session was signed out by the re-authentication
      expect(await admin.signOut()).toBe("CONFIRMED");
    });

    // ------------------------------------------------------------------------------------------ P1-T10
    it("P1-T10 tampered, unsigned, unknown and expired session cookies are rejected", async () => {
      const cookie = cookieOf(await signInRaw(sa1.email));
      const token = cookie.split("; ").find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
      const value = decodeURIComponent(token.slice(SESSION_COOKIE.length + 1));
      const [tok, sig] = value.split(".");
      const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
      for (const forged of [
        `${tok}.${flip(sig!)}`,
        `${flip(tok!)}.${sig}`,
        `${tok}`,
        "not-a-session",
      ]) {
        const r = await raw({
          method: "GET",
          path: "/api/platform/audit",
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}`,
        });
        expect(r.status).toBe(401);
      }
      expect((await raw({ method: "GET", path: "/api/platform/audit", cookie })).status).toBe(200);
      await t.pool.query(
        "update sessions set expires_at = clock_timestamp() - interval '1 second' where user_id = $1",
        [sa1.id],
      );
      expect((await raw({ method: "GET", path: "/api/platform/audit", cookie })).status).toBe(401);
      await resetSessions(sa1.id);
    });

    // ------------------------------------------------------------------------------------------ P1-T11
    it("P1-T11 the operator's own password change invalidates every earlier session; the old password stops working", async () => {
      const op = await operator();
      const earlier = cookieOf(await signInRaw(op.email)); // a second, earlier session of the same operator
      const c = await signedIn(op.email);
      const ids = async () =>
        (await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, op.id))).map(
          (s) => s.id,
        );
      const before = await ids();
      const change = await c.post("/api/account/change-password", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(change.status).toBe(200);
      // Every earlier session is gone; the route issued ONE replacement (server-side sign-in) and the client took its cookie.
      const after = await ids();
      expect(after).toHaveLength(1);
      expect(before.some((id) => after.includes(id))).toBe(false);
      expect((await c.get("/api/platform/audit")).status).toBe(200);
      expect(
        (await raw({ method: "GET", path: "/api/platform/audit", cookie: earlier })).status,
      ).toBe(401);
      expect((await signInRaw(op.email, PASSWORD)).status).toBe(401);
      const fresh = await signedIn(op.email, NEW_PASSWORD);
      expect((await fresh.get("/api/platform/audit")).status).toBe(200);
      expect(await fresh.signOut()).toBe("CONFIRMED");
    });

    it("P1-T11 a forced password change blocks platform access", async () => {
      const op = await operator();
      const c = await signedIn(op.email);
      // Restrictive fixture: no tenant path can set this flag for a role holder (C1A refuses that reset), so it is set directly.
      await t.db
        .insert(schema.userSecurityState)
        .values({ userId: op.id, passwordChangeRequired: true })
        .onConflictDoUpdate({
          target: schema.userSecurityState.userId,
          set: { passwordChangeRequired: true },
        });
      const res = await c.get("/api/platform/audit");
      expect(res.status).toBe(403);
      expect(code(res)).toBe("PASSWORD_CHANGE_REQUIRED");
      expect(await c.signOut()).toBe("CONFIRMED");
    });

    // ------------------------------------------------------------------------------------------ P1-T12
    it("P1-T12 an operator holds only C1A permissions and no tenant access; revocation ends its sessions and cached cookie", async () => {
      const op = await operator();
      const c = await signedIn(op.email);
      const own = await c.get("/api/platform/audit");
      expect(own.status).toBe(200);
      expect((own.json as { scope: string }).scope).toBe("own");
      expect((await c.get("/api/platform/operators")).status).toBe(403); // PLATFORM_SECURITY_ADMIN only
      expect((await c.post("/api/platform/operators", grantBody(email("x")))).status).toBe(403);
      expect((await c.get("/api/staff")).status).toBe(403); // no tenant AccessContext from a platform role

      const admin = await signedIn(sa1.email);
      expect((await admin.post(`/api/platform/operators/${op.grantId}/revoke`)).status).toBe(200);
      expect(await sessionsOf(op.id)).toBe(0);
      expect((await c.get("/api/platform/audit")).status).toBe(401); // the cached cookie is dead
      expect((await signInRaw(op.email)).status).not.toBe(200); // no role, no membership: no new session
      expect(await sessionsOf(op.id)).toBe(0);
      expect(await admin.signOut()).toBe("CONFIRMED");
      expect(await c.signOut()).toBe("CONFIRMED"); // already gone server-side: confirmed by the probe, not assumed
    });

    it("P1-T12 a security admin with a tenant VIEWER membership gains no tenant permission beyond VIEWER", async () => {
      const e = email("viewer-sa");
      await provisionUser(a, t, e, { organizationId: orgId, role: "VIEWER" });
      const admin = await signedIn(sa1.email);
      expect(
        (await admin.post("/api/platform/operators", grantBody(e, "PLATFORM_SECURITY_ADMIN")))
          .status,
      ).toBe(201);
      expect(await admin.signOut()).toBe("CONFIRMED");
      const c = await signedIn(e);
      expect((await c.get("/api/platform/operators")).status).toBe(200);
      expect((await c.get("/api/staff")).status).toBe(403); // staff.read: ADMIN and STAFF only, not VIEWER
      expect(await c.signOut()).toBe("CONFIRMED");
    });

    // ------------------------------------------------------------------------------------------ P1-T13
    it("P1-T13 concurrent revocation and grant by the revoked admin: exactly one serial order, both ways", async () => {
      const ROLE_LOCK = "select pg_advisory_lock(hashtextextended('platform_operator_roles', 0))";
      const ROLE_UNLOCK =
        "select pg_advisory_unlock(hashtextextended('platform_operator_roles', 0))";
      for (const order of ["revoke-first", "grant-first"] as const) {
        const sa2 = await operator("PLATFORM_SECURITY_ADMIN");
        const target = email(`t13-${order}`);
        await provisionUser(a, t, target);
        const admin = await signedIn(sa1.email);
        const second = await signedIn(sa2.email);
        const holder = await t.pool.connect();
        let revoke!: Promise<JsonResponse>;
        let grant!: Promise<JsonResponse>;
        try {
          await holder.query(ROLE_LOCK); // both mutations queue behind it, in the order they arrive
          if (order === "revoke-first") {
            revoke = admin.post(`/api/platform/operators/${sa2.grantId}/revoke`);
            await waitForLockWaiters(1);
            grant = second.post("/api/platform/operators", grantBody(target));
            await waitForLockWaiters(2);
          } else {
            grant = second.post("/api/platform/operators", grantBody(target));
            await waitForLockWaiters(1);
            revoke = admin.post(`/api/platform/operators/${sa2.grantId}/revoke`);
            await waitForLockWaiters(2);
          }
        } finally {
          await holder.query(ROLE_UNLOCK);
          holder.release();
        }
        const [g, r] = await Promise.all([grant, revoke]);
        expect(r.status, order).toBe(200);
        const granted = await t.pool.query(
          "select count(*)::int n from platform_operator_roles r join users u on u.id = r.user_id where u.email = $1 and r.status = 'ACTIVE'",
          [target],
        );
        expect(g.status, order).toBe(order === "revoke-first" ? 403 : 201);
        expect(granted.rows[0].n, order).toBe(order === "revoke-first" ? 0 : 1);
        expect(await sessionsOf(sa2.id)).toBe(0);
        expect(await admin.signOut()).toBe("CONFIRMED");
        expect(await second.signOut()).toBe("CONFIRMED");
      }
    });

    // ------------------------------------------------------------------------------------------ P1-T14 / T15
    it("P1-T14 successful sign-out deletes the server session and the old cookie is refused", async () => {
      await resetSessions(sa1.id);
      const res = await signInRaw(sa1.email);
      const cookie = cookieOf(res);
      const out = await raw({ method: "POST", path: "/api/auth/sign-out", body: {}, cookie });
      expect(out.status).toBe(200);
      expect(
        out.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/i.test(c)),
      ).toBe(true);
      expect(await sessionsOf(sa1.id)).toBe(0);
      expect((await raw({ method: "GET", path: "/api/platform/audit", cookie })).status).toBe(401);
      expect((await raw({ method: "GET", path: "/api/auth/get-session", cookie })).json).toBeNull();
    });

    /**
     * Test-only fault: deleting the sessions selected by `when` fails inside Better Auth. The exception text carries a canary and
     * the session token, so a log that printed the raw error, its cause or its SQL parameters would contain them.
     */
    async function failSessionDeletes(when: string) {
      await t.pool.query(`
      create function proof_fail_session_delete() returns trigger language plpgsql as $$
        begin raise exception '${CANARY} %', OLD.token; end $$;
      create trigger c1b_p1_fail_delete before delete on sessions for each row
        when (${when}) execute function proof_fail_session_delete();`);
      return () =>
        t.pool.query(
          "drop trigger c1b_p1_fail_delete on sessions; drop function proof_fail_session_delete();",
        );
    }
    const tokensOf = async (userId: string) =>
      (
        await t.pool.query<{ token: string }>("select token from sessions where user_id = $1", [
          userId,
        ])
      ).rows.map((r) => r.token);
    /** The auth diagnostic lines (structured JSON with one of the fixed auth messages) written since `from`. */
    const AUTH_MESSAGES = new Set([
      "auth library log",
      "unhandled auth error",
      "auth error response",
    ]);
    function diagnostics(from: number): Array<Record<string, unknown>> {
      return serverLog
        .slice(from)
        .join("")
        .split("\n")
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return AUTH_MESSAGES.has(String(parsed.message)) ? [parsed] : [];
          } catch {
            return [];
          }
        });
    }
    /** The server log written since `from`: no canary, no SQL text or parameters, none of `tokens`. */
    function expectSafeLog(from: number, tokens: readonly string[]) {
      const log = serverLog.slice(from).join("");
      expect(log).not.toContain(CANARY);
      expect(log).not.toMatch(/Failed query|params:|delete from|insert into|# SERVER_ERROR/i);
      for (const token of tokens)
        expect(log.includes(token), "a session token was logged").toBe(false);
      return log;
    }

    it("P1-T15 a database failure during sign-out still answers 200; the client reports NOT_REVOKED, clears local state, logs safely", async () => {
      const op = await operator();
      const c = await signedIn(op.email);
      const from = serverLog.length;
      const restore = await failSessionDeletes(`OLD.user_id = '${op.id}'`);
      try {
        const result = await c.signOut();
        expect(result).toBe("NOT_REVOKED");
        expect(SIGN_OUT_MESSAGES[result]).toMatch(/sign-out FAILED/);
        expect(c.hasSession()).toBe(false);
        expect(c.cookies()).toEqual([]);
        expect(await sessionsOf(op.id)).toBe(1); // the server session survived a sign-out that answered 200
        const log = expectSafeLog(from, await tokensOf(op.id));
        expect(log).toContain('"auth_log_code":"session_delete_failed"'); // the safe diagnostic
        expect(log).toContain('"sql_state":"P0001"');

        // Recovery through the account's own session management, while deletes still fail: not confirmed, and still safe.
        const again = await signedIn(op.email);
        expect(await again.revokeOtherSessions()).toBe("NOT_CONFIRMED");
        expectSafeLog(from, await tokensOf(op.id));
        await restore();
        expect(await again.revokeOtherSessions()).toBe("CONFIRMED");
        expect(await sessionsOf(op.id)).toBe(1); // only the recovery session itself
        expect(await again.signOut()).toBe("CONFIRMED");
      } finally {
        await restore().catch(() => undefined);
      }
    });

    it("P1-T15 a database failure while issuing a session refuses the sign-in and logs only safe fields", async () => {
      const op = await operator();
      const from = serverLog.length;
      await t.pool.query(`
      create function proof_fail_session_insert() returns trigger language plpgsql as $$
        begin raise exception '${CANARY} %', NEW.token; end $$;
      create trigger c1b_p1_fail_insert before insert on sessions for each row
        when (NEW.user_id = '${op.id}') execute function proof_fail_session_insert();`);
      try {
        // Better Auth does not catch a failed session insert: the raw database error escapes the router (onAPIError.throw)
        // and handleAuthRequest answers the bare 500 with exactly one fixed line.
        const res = await signInRaw(op.email);
        expect(res.status).toBe(500);
        expect(res.json).toBeUndefined();
        expect(res.setCookies).toEqual([]);
        expect(await sessionsOf(op.id)).toBe(0);
        const lines = diagnostics(from);
        expect(lines).toEqual([
          expect.objectContaining({
            message: "unhandled auth error",
            error_class: "DrizzleQueryError",
            sql_state: "P0001",
          }),
        ]);
        expectSafeLog(from, []);
      } finally {
        await t.pool.query(
          "drop trigger c1b_p1_fail_insert on sessions; drop function proof_fail_session_insert();",
        );
      }
      const ok = await signedIn(op.email); // behaviour restored with the fault removed
      expect(await ok.signOut()).toBe("CONFIRMED");
    });

    it("5xx diagnostics: an internal APIError 500 keeps its response and gets one fixed line; an exception gets one; 4xx none", async () => {
      const op = await operator();
      const c = await signedIn(op.email);
      const restore = await failSessionDeletes(`OLD.user_id = '${op.id}'`);
      try {
        // /revoke-sessions wraps the failed delete in APIError INTERNAL_SERVER_ERROR: its JSON response is unchanged.
        let from = serverLog.length;
        const apiError = await c.post("/api/auth/revoke-sessions");
        expect(apiError.status).toBe(500);
        expect(apiError.json).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(diagnostics(from).map((l) => [l.message, l.status, l.auth_path])).toEqual([
          ["auth library log", undefined, undefined], // the library's own fixed-field line for the failed delete
          ["auth error response", 500, "/revoke-sessions"],
        ]);
        expectSafeLog(from, await tokensOf(op.id));

        // /revoke-other-sessions lets the raw error escape: the bare 500 and ONE line, no duplicate 5xx line.
        const second = await signedIn(op.email);
        from = serverLog.length;
        const escaped = await second.post("/api/auth/revoke-other-sessions");
        expect(escaped.status).toBe(500);
        expect(escaped.json).toBeUndefined();
        expect(diagnostics(from).map((l) => l.message)).toEqual(["unhandled auth error"]);
        expectSafeLog(from, await tokensOf(op.id));
      } finally {
        await restore();
      }
      // Ordinary 4xx answers: unchanged, and no 5xx diagnostic.
      const from = serverLog.length;
      expect((await signInRaw(op.email, WRONG)).status).toBe(401);
      expect((await raw({ method: "GET", path: "/api/auth/list-sessions" })).status).toBe(401);
      expect(
        (
          await bare(
            "/api/auth/sign-out",
            { cookie: "x=y", origin: "https://evil.example", "cf-connecting-ip": ip() },
            {},
          )
        ).status,
      ).toBe(403);
      expect(serverLog.slice(from).join("")).not.toContain("auth error response");
      await resetSessions(op.id);
    });

    it("P1-T15 recovery wording never suggests that a new sign-in plus sign-out ends an abandoned session", () => {
      for (const text of [SIGN_OUT_MESSAGES.NOT_REVOKED, SIGN_OUT_MESSAGES.UNCONFIRMED, RECOVERY]) {
        expect(text).not.toMatch(/sign in again and sign out/i);
        expect(text).toContain("/revoke-other-sessions");
        expect(text).toContain("/list-sessions");
        expect(text).toMatch(/security administrator/);
        expect(text).toMatch(/removes its platform access/);
      }
      expect(SIGN_OUT_MESSAGES.NOT_REVOKED).toMatch(/Local credentials were cleared/);
    });

    // ------------------------------------------------------------------------------------------ re-authentication cleanup
    describe("re-authentication reports the verified outcome of ending the previous session", () => {
      it("normal re-authentication: the previous session is ended and verified", async () => {
        const op = await operator();
        const c = await signedIn(op.email);
        const res = await c.signIn(op.email, PASSWORD);
        expect(res).toEqual({ ok: true, previousSession: "CONFIRMED" });
        expect(describeSignIn(res)).toBe(
          "Signed in again. The previous session was ended (verified).",
        );
        expect(await sessionsOf(op.id)).toBe(1);
        expect(await c.signOut()).toBe("CONFIRMED");
      });

      it("old-session deletion fails: the new session is held, the old one is reported as still accepted", async () => {
        const op = await operator();
        const c = await signedIn(op.email);
        const [oldToken] = await tokensOf(op.id);
        const from = serverLog.length;
        const restore = await failSessionDeletes(`OLD.token = '${oldToken}'`);
        try {
          const res = await c.signIn(op.email, PASSWORD);
          expect(res).toEqual({ ok: true, previousSession: "NOT_REVOKED" });
          expect(describeSignIn(res)).toMatch(/previous session could NOT be ended/);
          expect(describeSignIn(res)).toContain(RECOVERY);
          expect(await tokensOf(op.id)).toContain(oldToken); // the old session is still accepted (NOT_REVOKED came from probing it)
          expect(await sessionsOf(op.id)).toBe(2);
          expect((await c.get("/api/platform/audit")).status).toBe(200); // the client holds the new session
          expect(await c.revokeOtherSessions()).toBe("NOT_CONFIRMED"); // no automatic retry succeeds while the fault lasts
          expectSafeLog(from, await tokensOf(op.id));
        } finally {
          await restore();
        }
        expect(await c.revokeOtherSessions()).toBe("CONFIRMED");
        expect(await tokensOf(op.id)).not.toContain(oldToken);
        expect(await c.signOut()).toBe("CONFIRMED");
      });

      it("an attempted identity switch keeps the current session and reports the other account's session outcome", async () => {
        const other = await operator();
        await resetSessions(sa1.id);
        const c = await signedIn(sa1.email);
        const res = await c.signIn(other.email, PASSWORD);
        expect(res).toEqual({
          ok: false,
          status: 200,
          reason: "identity_changed",
          rejectedSession: "CONFIRMED",
        });
        expect(describeSignIn(res)).toMatch(/different account\. The current session is kept/);
        expect(c.userId).toBe(sa1.id);
        expect((await c.get("/api/platform/audit")).status).toBe(200);
        expect(await sessionsOf(other.id)).toBe(0);
        expect(await sessionsOf(sa1.id)).toBe(1);

        // The other account's session cannot be ended: reported, not hidden; the current session is still kept.
        const restore = await failSessionDeletes(`OLD.user_id = '${other.id}'`);
        try {
          const res2 = await c.signIn(other.email, PASSWORD);
          expect(res2).toMatchObject({
            ok: false,
            reason: "identity_changed",
            rejectedSession: "NOT_REVOKED",
          });
          expect(describeSignIn(res2)).toMatch(/could not be ended/);
          expect(c.userId).toBe(sa1.id);
        } finally {
          await restore();
        }
        await resetSessions(other.id);
        expect(await c.signOut()).toBe("CONFIRMED");
      });
    });

    // ------------------------------------------------------------------------------------------ P1-T16 / T17
    describe("P1-T16 / T17 the proof CLI end to end: hidden prompt, cancellation, no credential leakage", () => {
      function fakeTerminal(typed: string) {
        const stdin = Object.assign(new PassThrough(), {
          isTTY: true,
          rawModes: [] as boolean[],
          setRawMode(mode: boolean) {
            stdin.rawModes.push(mode);
            return stdin;
          },
        });
        const written: string[] = [];
        const spies = [
          vi
            .spyOn(process, "stdin", "get")
            .mockReturnValue(stdin as unknown as typeof process.stdin),
          vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
            written.push(String(chunk));
            return true;
          }),
        ];
        stdin.write(typed);
        return { stdin, written, restore: () => spies.forEach((s) => s.mockRestore()) };
      }
      const cli = async (typed: string, address: string) => {
        const lines: string[] = [];
        const term = fakeTerminal(typed);
        const argv = [
          "--base-url",
          origin,
          "--ca-file",
          join(tlsDir, "cert.pem"),
          "--email",
          address,
        ];
        try {
          const exit = await main(
            argv,
            { out: (l) => lines.push(l), err: (l) => lines.push(l) },
            { "cf-connecting-ip": CLI_IP },
          );
          return { exit, lines, argv, ...term };
        } finally {
          term.restore();
        }
      };

      it("P1-T16 the password goes into a raw-mode prompt that echoes nothing; Ctrl-C sends nothing", async () => {
        const op = await operator();
        await resetPeerBucket();
        const run = await cli(`${PASSWORD}\r`, op.email);
        expect(run.stdin.rawModes).toEqual([true, false]);
        expect(run.written.join("")).toBe(`Password for ${op.email}: \n`); // the label and a newline, no echo
        expect(run.lines).toEqual([
          "Platform read: HTTP 200 (scope own).",
          SIGN_OUT_MESSAGES.CONFIRMED,
        ]);
        expect(run.exit).toBe(0);

        const cancel = await cli(`${PASSWORD.slice(0, 4)}\u0003`, op.email);
        expect(cancel.exit).toBe(130);
        expect(cancel.lines).toEqual(["Cancelled. Nothing was sent."]);
        expect(cancel.stdin.rawModes).toEqual([true, false]);
        expect(await sessionsOf(op.id)).toBe(0);
        const peer = await t.pool.query("select count from rate_limits where key = $1", [
          `${CLI_IP}|/sign-in/email`,
        ]);
        expect(peer.rows[0].count).toBe(1); // only the first run signed in; the cancelled one made no request
      });

      it("P1-T17 a full CLI run leaves no password or session token in output, server logs, argv, environment or new files", async () => {
        const op = await operator();
        await resetPeerBucket();
        const run = await cli(`${PASSWORD}\r`, op.email);
        expect(run.exit).toBe(0);
        expect(await sessionsOf(op.id)).toBe(0);

        const secrets = [
          PASSWORD,
          NEW_PASSWORD,
          ...(
            await t.pool.query<{ token: string }>("select token from proof_seen_tokens")
          ).rows.map((r) => r.token),
        ];
        expect(secrets.length).toBeGreaterThan(20);
        const haystacks: Array<[string, string]> = [
          ["cli output", [...run.lines, ...run.written].join("\n")],
          ["server log", serverLog.join("")],
          ["argv", [...run.argv, ...process.argv].join(" ")],
          ["environment", JSON.stringify(process.env)],
        ];
        // Every file created or modified since the suite started: the temporary directory and the repository's working tree.
        const files: string[] = [];
        const walk = (dir: string, depth: number) => {
          let entries: string[] = [];
          try {
            entries = readdirSync(dir);
          } catch {
            return;
          }
          for (const name of entries) {
            const p = join(dir, name);
            try {
              const s = statSync(p);
              if (s.isDirectory()) {
                if (depth > 0) walk(p, depth - 1);
              } else if (s.isFile() && s.mtimeMs >= startedAt && s.size < 5_000_000) files.push(p);
            } catch {
              // vanished or unreadable: not ours
            }
          }
        };
        walk(tmpdir(), 3);
        const changed = spawnSync(
          "git",
          ["ls-files", "--others", "--modified", "--exclude-standard"],
          { cwd: ROOT, encoding: "utf8" },
        )
          .stdout.split("\n")
          .filter((f) => f && !PROOF_SOURCES.has(f)); // the proof's own sources name the test passwords
        for (const f of changed) files.push(join(ROOT, f));
        for (const f of files) {
          try {
            haystacks.push([f, readFileSync(f, "latin1")]);
          } catch {
            // unreadable: skip
          }
        }
        for (const [where, text] of haystacks)
          for (const s of secrets) {
            // The failure message names the place only: it must not echo a credential or text around it.
            expect(text.includes(s), `${where} contains a credential`).toBe(false);
          }
        expect(serverLog.join("")).not.toContain(CANARY);

        const refused: string[] = [];
        expect(
          await main(["--password", PASSWORD], {
            out: (l) => refused.push(l),
            err: (l) => refused.push(l),
          }),
        ).toBe(2);
        expect(refused.join("\n")).not.toContain(PASSWORD);
      });
    });

    // ------------------------------------------------------------------------------------------ startup refusals
    describe("the launcher refuses before any connection or listener", () => {
      it("an otherwise valid environment with a wrong binding nonce or an arbitrary database is refused", async () => {
        // The running server's own environment with one change each; refusal precedes any listen, so its port is reused.
        const cases: Array<[string, Record<string, string>, string]> = [
          [
            "wrong nonce",
            { ...launchEnv, PROOF_BINDING_NONCE: "a".repeat(64) },
            "the database carries no matching, fresh proof-harness binding",
          ],
          [
            "missing nonce",
            { ...launchEnv, PROOF_BINDING_NONCE: "" },
            "the proof-harness binding nonce is missing or malformed",
          ],
          [
            "permanent database",
            { ...launchEnv, DATABASE_URL: t.url.replace(t.name, "al_ict_whatsapp") },
            "DATABASE_URL is not a valid disposable database URL",
          ],
          [
            "other port",
            { ...launchEnv, DATABASE_URL: t.url.replace(":55432/", ":5432/") },
            "DATABASE_URL must name a generated al_ict_test_* database on 127.0.0.1:55432",
          ],
          ["PG override", { ...launchEnv, PGHOST: "10.0.0.5" }, "PGHOST must not be set"],
          [
            "TLS verification off",
            { ...launchEnv, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
            "NODE_TLS_REJECT_UNAUTHORIZED must not be set",
          ],
        ];
        for (const [label, env, reason] of cases) {
          const run = await runLauncher(env);
          expect(run.code, label).toBe(1);
          expect(run.output.trim(), label).toBe(`PROOF_SERVER_REFUSED: ${reason}`);
        }
        // A fresh database without this run's binding, at the right place, is refused too.
        const other = await createTestDatabase();
        try {
          const run = await runLauncher({ ...launchEnv, DATABASE_URL: other.url });
          expect(run.output.trim()).toBe(
            "PROOF_SERVER_REFUSED: the proof-harness binding could not be verified",
          );
        } finally {
          await other.close();
        }
      });
    });

    // ------------------------------------------------------------------------------------------ P1-T18
    it("P1-T18 the proof server made no outbound call, printed no raw error, and serves through Next.js", async () => {
      const log = serverLog.join("");
      expect(log).not.toContain("PROOF_OUTBOUND_FETCH_BLOCKED");
      expect(log).not.toMatch(/# SERVER_ERROR|Failed query|DrizzleQueryError:/);
      expect(log).not.toContain(CANARY);
      expect(server.spawnargs.at(-1)).toBe("scripts/platform-auth-proof-server.ts");
      // Next's own pipeline is in front of the routes: its proxy answers an unauthenticated API call before any route runs.
      const res = await raw({ method: "GET", path: "/api/platform/audit" });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      });
    });
  },
);
