import { schema } from "@/db";
import type { LeadStatus } from "./types";

// The lead lifecycle rules as pure functions (ADR 0016). The database enforces the same rules with CHECKs and triggers (migration
// 0006); these exist so the service can refuse early with a clear answer and so the rules can be unit tested without a database.

// Compile-time guard: the view type and the schema enum list the same statuses.
const ALL: readonly LeadStatus[] = schema.LEAD_STATUSES;
const OPEN: ReadonlySet<string> = new Set(schema.OPEN_LEAD_STATUSES);
const SETTABLE: ReadonlySet<string> = new Set(schema.STAFF_SETTABLE_LEAD_STATUSES);

export const ALL_LEAD_STATUSES = ALL;
export const isOpenStatus = (status: string) => OPEN.has(status);
/** Phase 07 staff may set exactly these. The registration and payment statuses are reserved for the later workflow. */
export const isStaffSettable = (status: string) => SETTABLE.has(status);
/** A lead in a reserved status is read-only to staff. */
export const isReserved = (status: string) => !SETTABLE.has(status);

export type TransitionPlan =
  | { readonly kind: "noop" }
  /** open -> closed: closed_at is set. */
  | { readonly kind: "close" }
  /** closed -> open: a new cycle starts; another open lead must not exist. */
  | { readonly kind: "reopen" }
  /** open -> open, or closed -> closed: closed_at and the cycle do not move. */
  | { readonly kind: "move" };

/**
 * What a change of status does to the lifecycle fields. Both statuses must already be staff-settable (the caller refuses a
 * lead in a reserved status and a reserved target before asking).
 */
export function planTransition(from: LeadStatus, to: LeadStatus): TransitionPlan {
  if (from === to) return { kind: "noop" };
  const wasOpen = isOpenStatus(from);
  const willBeOpen = isOpenStatus(to);
  if (wasOpen && !willBeOpen) return { kind: "close" };
  if (!wasOpen && willBeOpen) return { kind: "reopen" };
  return { kind: "move" };
}
