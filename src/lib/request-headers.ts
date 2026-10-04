import { headers } from "next/headers";

/** The current request's headers as a plain Headers object (what the access/auth APIs expect). */
export async function requestHeaders(): Promise<Headers> {
  return new Headers(await headers());
}
