import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "./handler";
import {
  authLogFields,
  logAuthErrorResponse,
  logUnhandledAuthError,
  safeAuthLogger,
} from "./safe-log";

// The Better Auth log adapter and the public handler's 5xx diagnostics print members of fixed sets only (C1B-P1 closure). The
// database-backed regressions are in src/modules/platform/cli-auth-proof.db.test.ts.

// Synthetic secret markers shaped to PASS the previous checks (/^[A-Z][A-Za-z0-9]{0,63}$/ for names, /^[0-9A-Z]{5}$/ for codes).
const NAME_MARKER = "SECRETxNAMExMARKERx7Q";
const CODE_MARKER = "ZQSEC";
const CAUSE_CODE_MARKER = "QZSEC";
const TOKEN = "TOKENaaaaBBBBccccDDDDeeeeFFFFgggg";
const EMAIL = "victim@example.test";
const MARKERS = [NAME_MARKER, CODE_MARKER, CAUSE_CODE_MARKER, TOKEN, EMAIL, "SecretCtorMarker9"];

class SecretCtorMarker9 extends Error {}

const drizzleError = (code = "P0001") =>
  new DrizzleQueryError(
    'delete from "sessions" where "sessions"."token" = $1',
    [TOKEN],
    Object.assign(new Error(`injected ${TOKEN}`), { code }),
  );

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());
const expectNoMarker = () => {
  const out = lines.join("\n");
  for (const m of MARKERS)
    expect(out.includes(m), "a synthetic secret reached the log").toBe(false);
  expect(out).not.toMatch(/Failed query|params|delete from|injected/);
};

describe("authLogFields: every value is a member of a fixed set", () => {
  it("names recognized classes and SQLSTATEs", () => {
    expect(
      authLogFields("error", "Failed to delete session from database", [drizzleError()]),
    ).toEqual({
      auth_log_code: "session_delete_failed",
      auth_log_level: "error",
      error_class: "DrizzleQueryError",
      sql_state: "P0001",
    });
  });

  it("recognizes the database errors by shape when a production build has minified their class names", () => {
    class e extends Error {} // what a minified DrizzleQueryError / pg DatabaseError looks like by name
    const drizzleLike = Object.assign(new e(`Failed query: x params: ${TOKEN}`), {
      query: `delete ... ${TOKEN}`,
      params: [TOKEN],
      cause: { code: "P0001" },
    });
    const pgLike = Object.assign(new e(TOKEN), {
      severity: "ERROR",
      routine: "exec_stmt_raise",
      code: "23505",
    });
    expect(authLogFields("error", "", [drizzleLike])).toMatchObject({
      error_class: "DrizzleQueryError",
      sql_state: "P0001",
    });
    expect(authLogFields("error", "", [pgLike])).toMatchObject({
      error_class: "DatabaseError",
      sql_state: "23505",
    });
    logUnhandledAuthError(drizzleLike);
    expectNoMarker();
  });

  it("maps a valid-shaped but unknown error name, constructor name or code to the fixed value 'other'", () => {
    const named = Object.assign(new Error("x"), { name: NAME_MARKER, code: CODE_MARKER });
    const ctor = Object.assign(new SecretCtorMarker9("x"), {
      cause: { code: CAUSE_CODE_MARKER },
    });
    expect(authLogFields("error", "x", [named])).toMatchObject({
      error_class: "other",
      sql_state: "other",
    });
    expect(authLogFields("error", "x", [ctor])).toMatchObject({
      error_class: "other",
      sql_state: "other",
    });
    expect(authLogFields("error", NAME_MARKER, [])).toMatchObject({ error_class: undefined });
    expect(authLogFields(NAME_MARKER, "x", []).auth_log_level).toBe("other");
    expect(authLogFields("error", "x", [drizzleError(CODE_MARKER)]).sql_state).toBe("other");
    for (const v of Object.values(authLogFields("error", NAME_MARKER, [named, ctor])))
      expect(MARKERS).not.toContain(v);
  });

  it("never carries message suffixes, arguments, emails, URLs or unknown text", () => {
    for (const [message, args] of [
      [`Invalid origin: https://evil.example/?t=${TOKEN}`, []],
      ["User not found", [{ email: EMAIL }]],
      [`something new ${TOKEN}`, [{ token: TOKEN }, TOKEN]],
      ["INTERNAL_SERVER_ERROR", [drizzleError()]],
    ] as Array<[string, unknown[]]>) {
      const text = JSON.stringify(authLogFields("warn", message, args));
      for (const m of MARKERS) expect(text).not.toContain(m);
    }
  });
});

describe("log writers print only fixed fields", () => {
  it("safeAuthLogger and logUnhandledAuthError never print the raw error, its names, codes, cause or SQL parameters", () => {
    const named = Object.assign(new SecretCtorMarker9(`m ${TOKEN}`), {
      name: NAME_MARKER,
      code: CODE_MARKER,
      cause: { code: CAUSE_CODE_MARKER, message: TOKEN },
    });
    safeAuthLogger.log("error", "Failed to delete session from database", drizzleError());
    safeAuthLogger.log("error", NAME_MARKER, named);
    safeAuthLogger.log("warn", "User not found", { email: EMAIL });
    logUnhandledAuthError(named);
    logUnhandledAuthError(drizzleError(CODE_MARKER));
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expectNoMarker();
    expect(JSON.parse(lines[3]!)).toMatchObject({
      message: "unhandled auth error",
      error_class: "other",
      sql_state: "other",
    });
  });

  it("logAuthErrorResponse names only a fixed status range and a fixed auth path", () => {
    logAuthErrorResponse(503, "/api/auth/revoke-sessions");
    logAuthErrorResponse(500, `/api/auth/${TOKEN}`);
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { message: "auth error response", status: 503, auth_path: "/revoke-sessions" },
      { message: "auth error response", status: 500, auth_path: "other" },
    ]);
    expectNoMarker();
  });
});

describe("handleAuthRequest 5xx diagnostics (the response is never altered)", () => {
  const request = (path: string) =>
    new Request(`https://app.example.test/api/auth${path}`, { method: "GET" });
  const fake = (respond: () => Response | Promise<Response>) => ({
    handler: async () => respond(),
  });

  it("an internal APIError 500 (as better-call returns it) passes through unchanged with ONE fixed diagnostic", async () => {
    // better-call turns a thrown APIError into this response; Better Auth no longer logs it under onAPIError.throw.
    const original = new Response(
      JSON.stringify({ code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" }),
      {
        status: 500,
        headers: { "content-type": "application/json", "x-retry-after": "1" },
      },
    );
    original.headers.append("set-cookie", "__Secure-a=b; Path=/; Secure; HttpOnly");
    const res = await handleAuthRequest(
      request("/revoke-sessions"),
      fake(() => original),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("x-retry-after")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual(["__Secure-a=b; Path=/; Secure; HttpOnly"]);
    expect(await res.json()).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
    });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        message: "auth error response",
        status: 500,
        auth_path: "/revoke-sessions",
      }),
    ]);
  });

  it("an unexpected exception becomes the bare 500 with exactly one line (no duplicate 5xx line)", async () => {
    const res = await handleAuthRequest(
      request("/revoke-other-sessions"),
      fake(() => {
        throw drizzleError();
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(["unhandled auth error"]);
    expectNoMarker();
  });

  it("ordinary 4xx responses pass through untouched with no 5xx diagnostic", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      lines = [];
      const body = JSON.stringify({ code: `C${status}` });
      const res = await handleAuthRequest(
        request("/get-session"),
        fake(() => new Response(body, { status, headers: { "x-retry-after": "7" } })),
      );
      expect(res.status).toBe(status);
      expect(res.headers.get("x-retry-after")).toBe("7");
      expect(await res.text()).toBe(body);
      expect(lines.join("\n")).not.toContain("auth error response");
    }
  });
});
