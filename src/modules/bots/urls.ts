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

/**
 * Link-like detection for a short free-text ANSWER (a person's name), opt-in via `answer.rejectLinks`. It is deliberately
 * separate from `scanUrls`: that scanner judges links an author wrote on purpose and misses a bare domain (`example.org`).
 * Here any link-like shape is refused. Fixed rules, no author-supplied pattern, no lookup. Checked on an NFKC copy with the
 * ideographic/fullwidth full stops folded to "."; the stored answer is not changed.
 *   1. `scheme://` for any scheme, or a scheme that works without slashes (javascript:, mailto:, http:, ...).
 *   2. `www.` ; an `@` between word characters (an email address); a dotted IPv4 address.
 *   3. A hostname shape: two or more dot-separated labels of letters, digits, marks and hyphens, in any script.
 *      a. followed by `/`, `?`, `#` or `:port` (a path or port): always link-like;
 *      b. otherwise link-like when the last label is 2+ letters (any script, so any suffix, listed or not) or an ASCII
 *         IDN label (`xn--...`, any case), UNLESS it is written as dotted initials and a surname (the exception below).
 * Initials exception (an intentional data-quality trade-off): TWO OR MORE labels before the last, each one initial (a
 * single uppercase letter, or one Sinhala/Tamil syllable of at most 3 code points), and the last label name-cased (an
 * uppercase letter then lowercase letters, or Sinhala/Tamil). So `K.M.Silva`, `K.M.Dev` and `A.B.De` pass, while `T.Co`,
 * `X.Com`, `x.com`, `example.nz` and a Chinese domain such as `<two CJK letters>.<two CJK letters>` do not.
 * Consequences: a multi-initial shape such as `A.B.Com` also passes; a single joined initial (`K.Perera`) and joined words
 * (`Dr.Nimal`, `Nimal.Perera`, `St.John`) are refused and re-prompted (the spaced forms pass). A label of digits only
 * does not count as a suffix, so `1.5` passes.
 * shortcut: spaced or bracketed dots (`example dot org`) and other deliberate obfuscation are NOT recognised. This is a
 * data-quality rule, not a security boundary.
 */
const SCHEME_SLASHES = /[a-z][a-z0-9+.\-]*:\/\//i;
const SCHEME_BARE =
  /(?<![a-z0-9])(?:javascript|vbscript|data|file|blob|about|mailto|tel|sms|intent|ftp|sftp|ws|wss|http|https):/i;
const EMAIL = /[\p{L}\p{N}._%+-]@[\p{L}\p{N}-]/u;
const DOTTED_IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/;
const LABEL = String.raw`[\p{L}\p{N}][\p{L}\p{N}\p{M}-]*`;
const HOSTNAME = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}.\-])${LABEL}(?:\.${LABEL})+(?![\p{L}\p{N}\p{M}\-])`,
  "gu",
);
const AFTER_HOST_IS_URL = /^(?:[/?#]|:\d)/;
/** 2+ letters in any script, or an ASCII IDN (punycode) label such as `xn--fiqs8s`. */
const SUFFIX = /^(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)$/iu;
const SI_TA = String.raw`[\p{Script=Sinhala}\p{Script=Tamil}]`;
const INITIAL = new RegExp(String.raw`^(?:\p{Lu}|${SI_TA}{1,3})$`, "u");
const SURNAME = new RegExp(String.raw`^(?:\p{Lu}[\p{Ll}\p{M}]+|${SI_TA}+)$`, "u");

function hostnameLike(text: string): boolean {
  for (const match of text.matchAll(HOSTNAME)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (AFTER_HOST_IS_URL.test(after)) return true;
    const labels = match[0].split(".");
    const last = labels.at(-1)!;
    if (!SUFFIX.test(last)) continue;
    const initials =
      labels.length >= 3 && // two or more initials: `T.Co` / `X.Com` get no exception
      labels.slice(0, -1).every((l) => INITIAL.test(l)) &&
      SURNAME.test(last);
    if (!initials) return true;
  }
  return false;
}

export function looksLikeLink(value: string): boolean {
  const folded = value.normalize("NFKC").replace(/[\u3002\uff0e\uff61]/g, ".");
  return (
    SCHEME_SLASHES.test(folded) ||
    SCHEME_BARE.test(folded) ||
    /(?<![\p{L}\p{N}])www\./iu.test(folded) ||
    EMAIL.test(folded) ||
    DOTTED_IPV4.test(folded) ||
    hostnameLike(folded)
  );
}
