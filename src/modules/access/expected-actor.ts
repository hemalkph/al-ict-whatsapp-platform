import { z } from "zod";
import { ActorChangedError, ValidationError } from "@/shared/errors/http-errors";
import { emitSecurityEvent } from "@/shared/security/events";
import type { AccessContext } from "./access";

// The expected-actor guard.
//
// A browser tab can outlive the session it was opened in: another tab may sign the user out and a different (equally
// authorized) member in. Idempotency (Phase 05) is scoped to the MEMBERSHIP, so a request replayed from the old tab would be
// created again under the new member. To prevent that, a client may state who it believes it is acting as, in the
// `X-Expected-Actor` request header: percent-encoded JSON {"userId","organizationId","membershipId"}.
//
// This is an ASSERTION, never authorization: the actor is always the one the server derived from the session cookie. The guard
// only refuses (409 ACTOR_CHANGED) when the two differ, before any handler can write. It grants nothing: a caller that states
// its own real identifiers still needs the ordinary permission for the operation. A header that is present but malformed,
// incomplete, oversized or duplicated fails closed (400). An absent header means "no assertion" (older callers); the inbox
// always sends it (pinned by a boundary test).

export const EXPECTED_ACTOR_HEADER = "x-expected-actor";
const MAX_HEADER_LENGTH = 1024;

const id = z.string().min(1).max(128);
const expectedActorSchema = z.strictObject({
  userId: id,
  organizationId: id,
  membershipId: id,
});
export type ExpectedActor = z.infer<typeof expectedActorSchema>;

export function parseExpectedActor(header: string): ExpectedActor {
  if (header.length > MAX_HEADER_LENGTH) throw new ValidationError([EXPECTED_ACTOR_HEADER]);
  let json: unknown;
  try {
    json = JSON.parse(decodeURIComponent(header));
  } catch {
    throw new ValidationError([EXPECTED_ACTOR_HEADER]);
  }
  const parsed = expectedActorSchema.safeParse(json);
  if (!parsed.success) throw new ValidationError([EXPECTED_ACTOR_HEADER]);
  return parsed.data;
}

/** Throws unless the authenticated context is exactly the asserted actor (all three identifiers). */
export function assertExpectedActor(ctx: AccessContext, header: string): void {
  const expected = parseExpectedActor(header);
  if (
    expected.userId !== ctx.userId ||
    expected.organizationId !== ctx.organizationId ||
    expected.membershipId !== ctx.membershipId
  ) {
    emitSecurityEvent({
      event: "access.actor_changed",
      outcome: "denied",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      membershipId: ctx.membershipId,
    });
    throw new ActorChangedError();
  }
}
