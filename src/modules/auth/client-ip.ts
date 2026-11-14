import { getIPFromHeader } from "@better-auth/core/utils/ip";
import { readAuthEnv } from "./env";

// TRUSTED CLIENT-IP CONTRACT (Phase 08G-7B C1B-P3, ADR 0012). One header, one parser.
//
// The client IP (rate-limit bucket and sessions.ip_address) comes ONLY from CF-Connecting-IP, the header the target ingress
// (Cloudflare edge -> Cloudflare Tunnel) sets and overwrites. X-Forwarded-For, X-Real-IP and Forwarded are never read.
// The value is parsed by Better Auth's own getIPFromHeader (the function its limiter and session writer call), so this guard and
// the library cannot disagree on an accepted value: exactly one syntactically valid IPv4/IPv6 address, no comma at all; IPv4-mapped IPv6 becomes IPv4;
// IPv6 is masked to its /64.
//
// LIMIT: the application cannot prove the header came from Cloudflare. This is only as strong as the network topology that makes
// the tunnel the sole path to the origin (docs/DEPLOYMENT.md). It is not, by itself, production spoof resistance.

export const CLIENT_IP_HEADER = "cf-connecting-ip";
export const CLIENT_IP_V6_SUBNET = 64;

/**
 * The trusted client IP in normalized form, or null: the caller must reject (403), never continue without one (Better Auth would
 * put the request in a shared "no-trusted-ip" bucket, or use 127.0.0.1 under NODE_ENV=development/test).
 * Local development only (BETTER_AUTH_LOCAL_INGRESS=loopback, refused in production by readAuthEnv): an ABSENT header is
 * loopback. A present but invalid header is always rejected. The fallback does NOT verify the peer: it is safe only while the
 * server listens on loopback (`npm run dev` binds 127.0.0.1) with no port forwarding, tunnel or shared exposure.
 */
export function trustedClientIp(
  headers: Headers,
  loopbackWhenAbsent: () => boolean = () => readAuthEnv().loopbackClientIp === true,
): string | null {
  // Headers.get joins repeated headers with ", ": a duplicated header is a chain and is rejected like one.
  const value = headers.get(CLIENT_IP_HEADER);
  if (value === null) return loopbackWhenAbsent() ? "127.0.0.1" : null;
  // Any comma is a chain. Rejected here because the library parser drops empty elements and would accept "203.0.113.7,".
  if (value.includes(",")) return null;
  // Lowercased first: the 1.7.7 parser misses an UPPERCASE hex-form IPv4-mapped address ("::FFFF:c633:6409") and masks it into
  // the all-zero /64, one bucket for every such client. Callers pass the RESULT on, so Better Auth only sees canonical values.
  return getIPFromHeader(value.toLowerCase(), { ipv6Subnet: CLIENT_IP_V6_SUBNET });
}
