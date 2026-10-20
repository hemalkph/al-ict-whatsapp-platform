// URL policy (ADR 0017, owner decision C): only https URLs; every other scheme is an error; every https URL is surfaced
// for human review. Pure: `new URL` parses text and performs no I/O.

export type UrlFinding = {
  readonly code:
    | "URL_SCHEME_UNSUPPORTED"
    | "URL_MALFORMED"
    | "URL_CREDENTIALS_NOT_ALLOWED"
    | "URL_INTERPOLATION_NOT_ALLOWED"
    | "URL_REVIEW_RECOMMENDED"
    | "URL_HOST_UNUSUAL"
    | "URL_SCHEME_MISSING";
  /** Only safe, short facts: a scheme name or a host name. Never the whole URL, a path or a query. */
  readonly context: Record<string, string>;
};

const BEFORE = String.raw`(?<![A-Za-z0-9+.\-])`;
/** `scheme://...` for any scheme. */
const WITH_SLASHES = new RegExp(
  String.raw`${BEFORE}([A-Za-z][A-Za-z0-9+.\-]{0,30}):\/\/[^\s<>"'\x60]*`,
  "g",
);
/** Schemes that work without `//` (a browser or phone acts on them) and `https:` / `http:` written without slashes. */
const WITHOUT_SLASHES = new RegExp(
  String.raw`${BEFORE}(javascript|vbscript|data|file|blob|about|mailto|tel|sms|intent|ftp|sftp|ws|wss|http|https):(?!\/\/)(?=\S)`,
  "gi",
);
/** A link written without a scheme, which WhatsApp would still turn into a clickable link. */
const WWW = /(?<![A-Za-z0-9.@\/-])www\.[^\s<>"'`]+/gi;

/** A run of characters a URL can contain (what WhatsApp would treat as one link at most). */
const TOKEN = /[^\s<>"'`]+/g;
/** A placeholder (or a stray brace pair) in the same token as `//` or `www.` builds a link at run time. */
const BUILDS_LINK = /\/\/|www\./i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const CLOSER_TO_OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

type Span = readonly [number, number];
const within = (spans: readonly Span[], at: number) =>
  spans.some(([from, to]) => at >= from && at < to);

/**
 * Removes prose punctuation after a URL. A closing bracket is removed only when the URL has no matching opener, so
 * `https://[2001:db8::1]` and `.../Foo_(bar)` keep theirs while `(see https://example.org)` loses its parenthesis.
 */
function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    const opener = CLOSER_TO_OPENER[last];
    const strip = opener
      ? url.split(last).length > url.split(opener).length // more closers than openers
      : ".,;:!?".includes(last);
    if (!strip) return url;
    url = url.slice(0, -1);
  }
}

/** Every URL-like occurrence in a string and what the policy says about it. */
export function scanUrls(text: string): UrlFinding[] {
  const findings: UrlFinding[] = [];
  /** Whole URL spans: nothing inside is scanned again. */
  const covered: Span[] = [];
  /** The query and fragment of a recognized https URL: scheme-like text there is a parameter, not a link. */
  const queries: Span[] = [];

  // (1) A URL assembled from placeholders cannot be judged statically (`{{scheme}}://...`, `https://{{host}}`, ...):
  // refused outright. The engine re-checks fully rendered text before sending (ADR 0017, Phase 08B).
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    if ((token.includes("{{") || token.includes("}}")) && BUILDS_LINK.test(token)) {
      const start = match.index ?? 0;
      covered.push([start, start + token.length]);
      findings.push({ code: "URL_INTERPOLATION_NOT_ALLOWED", context: {} });
    }
  }

  for (const match of text.matchAll(WITH_SLASHES)) {
    const start = match.index ?? 0;
    if (within(covered, start)) continue;
    const candidate = trimTrailing(match[0]);
    covered.push([start, start + candidate.length]);
    const scheme = (match[1] ?? "").toLowerCase();
    if (scheme !== "https") {
      findings.push({ code: "URL_SCHEME_UNSUPPORTED", context: { scheme } });
      continue;
    }
    const assessed = assessHttps(candidate);
    findings.push(...assessed);
    const query = candidate.search(/[?#]/);
    if (assessed[0]?.code === "URL_REVIEW_RECOMMENDED" && query > 0)
      queries.push([start + query, start + candidate.length]);
  }

  for (const match of text.matchAll(WITHOUT_SLASHES)) {
    if (within(queries, match.index ?? 0)) continue;
    const scheme = (match[1] ?? "").toLowerCase();
    findings.push(
      scheme === "https" || scheme === "http"
        ? { code: "URL_MALFORMED", context: { scheme } }
        : { code: "URL_SCHEME_UNSUPPORTED", context: { scheme } },
    );
  }

  for (const match of text.matchAll(WWW)) {
    if (within(covered, match.index ?? 0)) continue;
    findings.push({ code: "URL_SCHEME_MISSING", context: {} });
  }
  return findings;
}

function assessHttps(candidate: string): UrlFinding[] {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return [{ code: "URL_MALFORMED", context: { scheme: "https" } }];
  }
  if (url.protocol !== "https:" || url.hostname === "") {
    return [{ code: "URL_MALFORMED", context: { scheme: "https" } }];
  }
  if (url.username !== "" || url.password !== "") {
    return [{ code: "URL_CREDENTIALS_NOT_ALLOWED", context: {} }];
  }
  const host = url.hostname;
  const out: UrlFinding[] = [{ code: "URL_REVIEW_RECOMMENDED", context: { host } }];
  const unusual =
    IPV4.test(host) ||
    host.startsWith("[") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.split(".").some((label) => label.startsWith("xn--")) ||
    url.port !== "";
  if (unusual) out.push({ code: "URL_HOST_UNUSUAL", context: { host } });
  return out;
}
