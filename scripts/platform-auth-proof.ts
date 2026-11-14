import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promptHidden } from "./prompt";

// Phase 08G-7B C1B-P1: PROOF-ONLY non-browser client for the existing Better Auth HTTP flow (plan section 10). Not the C1B CLI:
// it has no operational command. It proves that an operator can sign in through the public /api/auth/sign-in/email endpoint
// over verified HTTPS, hold the session cookies in process memory only, call an existing platform route, re-authenticate and
// sign out, and that a sign-out is reported as confirmed only when the server no longer accepts the old cookie.
//
// Rules: the password comes only from the hidden prompt (never argv, env, file, URL or log); requests go only to the one
// https origin given, with that Origin header and TLS verification against the CA given; redirects are never followed;
// response bodies are never printed (sign-in and get-session bodies carry the session token).

const MAX_RESPONSE_BYTES = 1024 * 1024;
const SIGN_IN = "/api/auth/sign-in/email";
const SIGN_OUT = "/api/auth/sign-out";
const GET_SESSION = "/api/auth/get-session";

/** The exact https origin of a base URL; anything else (http, credentials, path, query, fragment) is refused. */
export function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The base URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("The base URL must use https.");
  if (url.username || url.password) throw new Error("The base URL must not contain credentials.");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error("The base URL must be an origin only (no path, query or fragment).");
  return url.origin;
}

type Cookie = {
  readonly value: string;
  readonly expiresAt: number | null; // null: session cookie (lives as long as this process)
  readonly attributes: {
    secure: boolean;
    httpOnly: boolean;
    sameSite: string | null;
    path: string | null;
  };
};

/** In-memory cookie store for ONE origin. Never written anywhere; values are never exposed except as the Cookie header. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  /** Applies Set-Cookie headers in order: a later one replaces an earlier one; Max-Age<=0, a past Expires or an empty value deletes. */
  apply(setCookies: readonly string[], now = Date.now()): void {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let expiresAt: number | null = null;
      let maxAgeSeen = false;
      const attributes: Cookie["attributes"] = {
        secure: false,
        httpOnly: false,
        sameSite: null,
        path: null,
      };
      for (const attr of attrs) {
        const i = attr.indexOf("=");
        const key = (i < 0 ? attr : attr.slice(0, i)).toLowerCase();
        const val = i < 0 ? "" : attr.slice(i + 1);
        if (key === "secure") attributes.secure = true;
        else if (key === "httponly") attributes.httpOnly = true;
        else if (key === "samesite") attributes.sameSite = val.toLowerCase();
        else if (key === "path") attributes.path = val;
        else if (key === "max-age") {
          maxAgeSeen = true; // Max-Age takes precedence over Expires (RFC 6265 5.3)
          expiresAt = now + Number(val) * 1000;
        } else if (key === "expires" && !maxAgeSeen) expiresAt = Date.parse(val);
      }
      // A cookie the server would let a browser send over plain http is not kept (this client only speaks https anyway).
      if (!attributes.secure || value === "" || (expiresAt !== null && !(expiresAt > now))) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, { value, expiresAt, attributes });
    }
  }

  header(now = Date.now()): string | undefined {
    for (const [name, c] of this.cookies)
      if (c.expiresAt !== null && c.expiresAt <= now) this.cookies.delete(name);
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, c]) => `${name}=${c.value}`).join("; ");
  }

  /** Names and attributes only (no values), for diagnostics and tests. */
  describe(): Array<{ name: string } & Cookie["attributes"] & { persistent: boolean }> {
    return [...this.cookies].map(([name, c]) => ({
      name,
      ...c.attributes,
      persistent: c.expiresAt !== null,
    }));
  }

  clear(): void {
    this.cookies.clear();
  }
}

export type HttpsTarget = { readonly origin: string; readonly ca: string | Buffer };
export type JsonResponse = {
  status: number;
  setCookies: string[];
  location?: string;
  json: unknown;
};

/**
 * One request to `origin` + `path` over https with TLS verification against `ca`. The Origin header is always the target origin.
 * A 3xx is returned as is and never followed. Used by the client and, for raw boundary tests, by the proof tests.
 */
export function httpsJson(
  target: HttpsTarget,
  init: {
    method: string;
    path: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  },
): Promise<JsonResponse> {
  if (!init.path.startsWith("/") || init.path.startsWith("//"))
    throw new Error("Request path must be origin-relative.");
  const url = new URL(init.path, target.origin);
  if (url.origin !== target.origin) throw new Error("Request would leave the configured origin.");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = {
    ...init.headers,
    origin: target.origin,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method,
        headers,
        ca: target.ca,
        rejectUnauthorized: true,
        agent: false,
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("Response too large."));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          try {
            json = text === "" ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            setCookies: res.headers["set-cookie"] ?? [],
            location: res.headers.location,
            json,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out.")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** CONFIRMED: the server no longer accepts the old cookie. NOT_REVOKED: it still does. UNCONFIRMED: no reliable answer. */
export type SignOutResult = "CONFIRMED" | "NOT_REVOKED" | "UNCONFIRMED" | "NO_SESSION";

/**
 * What an operator can do about a session that may still be accepted. A new sign-in followed by a sign-out does NOT end an
 * earlier session (sign-out ends only the session it carries). The account's own session management does: from a NEW session,
 * /revoke-other-sessions, then /list-sessions must show that session alone (revokeOtherSessions() below does both). Otherwise
 * only a platform security administrator can end it, and only by revoking the account's platform role, which also removes its
 * platform access, needs that administrator's recent re-authentication, and is refused for the last security administrator.
 */
export const RECOVERY =
  "To end it: sign in again and revoke your other sessions (/revoke-other-sessions), then confirm with /list-sessions that only " +
  "the new session remains. If that cannot be confirmed, report it to a platform security administrator: they can end every " +
  "session of the account only by revoking its platform role, which also removes its platform access.";

export const SIGN_OUT_MESSAGES: Record<SignOutResult, string> = {
  CONFIRMED: "Signed out: the server no longer accepts this session.",
  NOT_REVOKED:
    "WARNING: server-side sign-out FAILED. The server still accepts this session until it expires. Local credentials " +
    `were cleared. ${RECOVERY}`,
  UNCONFIRMED:
    "WARNING: server-side sign-out could not be confirmed. Treat the session as still accepted until it expires. Local " +
    `credentials were cleared. ${RECOVERY}`,
  NO_SESSION: "No session was held.",
};

export type SignInResult =
  /** Signed in; `previousSession` is the verified outcome of ending the session held before (NO_SESSION: none was held). */
  | { ok: true; previousSession: SignOutResult }
  | { ok: false; status: number }
  /** The server answered for another account: the session held before is KEPT; `rejectedSession` is the other account's. */
  | { ok: false; status: number; reason: "identity_changed"; rejectedSession: SignOutResult };

/** The operator-visible line for a sign-in result. Never claims an ending that was not verified. */
export function describeSignIn(result: SignInResult): string {
  if (!result.ok && "reason" in result) {
    const kept =
      "Refused: that password belongs to a different account. The current session is kept.";
    return result.rejectedSession === "CONFIRMED" || result.rejectedSession === "NO_SESSION"
      ? `${kept} The other account's new session was ended (verified).`
      : `${kept} WARNING: the other account's new session could not be ended and may remain accepted until it expires; ` +
          "report it to a platform security administrator.";
  }
  if (!result.ok) return `Sign-in refused (HTTP ${result.status}).`;
  switch (result.previousSession) {
    case "NO_SESSION":
      return "Signed in.";
    case "CONFIRMED":
      return "Signed in again. The previous session was ended (verified).";
    case "NOT_REVOKED":
      return `Signed in again. WARNING: the previous session could NOT be ended; the server still accepts it until it expires. ${RECOVERY}`;
    case "UNCONFIRMED":
      return `Signed in again. WARNING: ending the previous session could not be confirmed; treat it as still accepted. ${RECOVERY}`;
  }
}

export type OperatorClientOptions = {
  readonly baseUrl: string;
  readonly ca: string | Buffer;
  /** PROOF HARNESS ONLY: extra request headers (the tests give each case its own client-IP limiter bucket). */
  readonly extraHeaders?: Record<string, string>;
};

export function createOperatorClient(options: OperatorClientOptions) {
  const target: HttpsTarget = { origin: parseBaseUrl(options.baseUrl), ca: options.ca };
  const jar = new CookieJar();
  let userId: string | null = null;

  /** With the held cookies (and applying the server's cookie updates), or with an explicit `cookie` (updates ignored). */
  async function send(method: string, path: string, body?: unknown, cookie?: string) {
    const held = cookie === undefined;
    const res = await httpsJson(target, {
      method,
      path,
      body,
      cookie: held ? jar.header() : cookie,
      headers: options.extraHeaders,
    });
    if (res.status >= 300 && res.status < 400)
      throw new Error(`Redirect refused (HTTP ${res.status}).`);
    if (held) jar.apply(res.setCookies);
    return res;
  }

  /** Signs out the session that `cookie` carries and asks the server whether that cookie is still accepted. */
  async function revoke(cookie: string | undefined): Promise<SignOutResult> {
    if (!cookie) return "NO_SESSION";
    try {
      const out = await send("POST", SIGN_OUT, {}, cookie);
      if (out.status !== 200) return "UNCONFIRMED";
      // A 200 from sign-out is not evidence: Better Auth 1.7.7 logs and swallows a failed session delete.
      const probe = await send("GET", GET_SESSION, undefined, cookie);
      if (probe.status !== 200) return "UNCONFIRMED";
      if (probe.json === null) return "CONFIRMED";
      return (probe.json as { session?: unknown } | undefined)?.session
        ? "NOT_REVOKED"
        : "UNCONFIRMED";
    } catch {
      return "UNCONFIRMED";
    }
  }

  return {
    origin: target.origin,
    get userId() {
      return userId;
    },
    cookies: () => jar.describe(),
    hasSession: () => jar.header() !== undefined,

    /**
     * Public email sign-in (rememberMe false). A re-authentication must be the same human: if the server answers for another
     * account, that account's new session is ended (verified, reported) and the session held before is kept untouched. On
     * success the new session is held and the previous one is ended once (no retry); its VERIFIED outcome is returned, so a
     * failed cleanup is never reported as done. A refused sign-in leaves the held session as it was.
     */
    async signIn(email: string, password: string): Promise<SignInResult> {
      const previous = jar.header();
      const res = await httpsJson(target, {
        method: "POST",
        path: SIGN_IN,
        body: { email, password, rememberMe: false },
        headers: options.extraHeaders,
      });
      if (res.status !== 200) return { ok: false, status: res.status };
      const signedIn = (res.json as { user?: { id?: unknown } } | undefined)?.user?.id;
      const fresh = new CookieJar();
      fresh.apply(res.setCookies);
      if (typeof signedIn !== "string" || (userId !== null && signedIn !== userId)) {
        const rejectedSession = await revoke(fresh.header());
        fresh.clear();
        return { ok: false, status: res.status, reason: "identity_changed", rejectedSession };
      }
      jar.clear();
      jar.apply(res.setCookies);
      userId = signedIn;
      return { ok: true, previousSession: await revoke(previous) };
    },

    /**
     * Recovery from an earlier session that could not be ended: from the held (new) session, revoke every other session of the
     * account, then list the account's sessions. CONFIRMED only when the list holds exactly one session.
     */
    async revokeOtherSessions(): Promise<"CONFIRMED" | "NOT_CONFIRMED"> {
      try {
        const revoked = await send("POST", "/api/auth/revoke-other-sessions", {});
        const listed = await send("GET", "/api/auth/list-sessions");
        return revoked.status === 200 &&
          listed.status === 200 &&
          Array.isArray(listed.json) &&
          listed.json.length === 1
          ? "CONFIRMED"
          : "NOT_CONFIRMED";
      } catch {
        return "NOT_CONFIRMED";
      }
    },

    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown) => send("POST", path, body ?? {}),

    /** Signs out, checks the result with the server, and clears local state whatever the outcome. */
    async signOut(): Promise<SignOutResult> {
      try {
        return await revoke(jar.header());
      } finally {
        jar.clear();
        userId = null;
      }
    },
  };
}

export type OperatorClient = ReturnType<typeof createOperatorClient>;

type Io = { out(line: string): void; err(line: string): void };
const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

function parseArgs(argv: readonly string[]): { baseUrl: string; caFile: string; email: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (
      !flag ||
      !["--base-url", "--ca-file", "--email"].includes(flag) ||
      argv[i + 1] === undefined
    )
      throw new Error(
        "Usage: platform-auth-proof --base-url https://host:port --ca-file <pem> --email <address>",
      );
    values.set(flag, argv[i + 1]!);
  }
  const get = (k: string) => {
    const v = values.get(k);
    if (!v) throw new Error(`${k} is required.`);
    return v;
  };
  return { baseUrl: get("--base-url"), caFile: get("--ca-file"), email: get("--email") };
}

/**
 * Proof run: hidden password prompt, sign-in, one permitted platform read (GET /api/platform/audit?limit=1), sign-out with
 * confirmation. Prints statuses and fixed messages only. Exit 0 only when every step succeeded and sign-out was confirmed.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: Io = consoleIo,
  /** PROOF HARNESS ONLY (no CLI flag): the tests play the trusted ingress and supply the client-IP header. */
  extraHeaders?: Record<string, string>,
): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const client = createOperatorClient({
    baseUrl: args.baseUrl,
    ca: readFileSync(args.caFile),
    extraHeaders,
  });
  let password: string | undefined;
  try {
    password = await promptHidden(`Password for ${args.email}: `);
  } catch (error) {
    io.err(`${(error as Error).message} Nothing was sent.`);
    return 130;
  }
  let signedIn: SignInResult;
  try {
    signedIn = await client.signIn(args.email, password);
  } catch {
    io.err("Sign-in failed: the server could not be reached securely.");
    return 1;
  } finally {
    password = undefined; // shortcut: a JS string cannot be wiped; dropping the only reference is all a script can do
  }
  if (!signedIn.ok) {
    io.err(describeSignIn(signedIn));
    return 1;
  }
  let readOk = false;
  try {
    const res = await client.get("/api/platform/audit?limit=1");
    readOk = res.status === 200;
    const scope = (res.json as { scope?: unknown } | undefined)?.scope;
    io.out(
      `Platform read: HTTP ${res.status}${typeof scope === "string" ? ` (scope ${scope})` : ""}.`,
    );
  } catch {
    io.err("Platform read failed: the server could not be reached securely.");
  } finally {
    const result = await client.signOut();
    (result === "CONFIRMED" ? io.out : io.err)(SIGN_OUT_MESSAGES[result]);
    if (result !== "CONFIRMED") readOk = false;
  }
  return readOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
