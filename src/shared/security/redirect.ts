// Post-login redirect targets must be safe same-origin relative application paths. Anything else falls back.

const MAX_LENGTH = 2048;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

function startsLikeSafePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !CONTROL_OR_BACKSLASH.test(value);
}

export function isSafeRedirectPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return false;
  if (!startsLikeSafePath(value)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value); // catches %2f%2f, %5c and encoded control characters
  } catch {
    return false;
  }
  if (!startsLikeSafePath(decoded)) return false;
  try {
    const url = new URL(value, "http://app.invalid");
    if (url.origin !== "http://app.invalid") return false;
    // dot-segment normalization must not produce a protocol-relative or backslash form
    return startsLikeSafePath(url.pathname + url.search + url.hash);
  } catch {
    return false;
  }
}

/** Returns the target when safe, otherwise `fallback` (default "/"). */
export function safeRedirectPath(value: unknown, fallback = "/"): string {
  return isSafeRedirectPath(value) ? value : fallback;
}
