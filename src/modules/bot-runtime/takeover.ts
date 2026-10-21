// Staff takeover of a live session (Phase 08E-1; V3.2 J.2 rules 4 to 6, plan section I.1). PURE. The runtime reads the staff
// control events sequenced AFTER the session started (control_seq > started_control_seq, the same predicate the dispatcher's
// bot_request_hold_code uses, so the step and the dispatcher cannot disagree about what a takeover is) and this function
// classifies them.

export type StaffControlEvent =
  /** Any ASSIGNMENT conversation event: assign, reassign or unassign. */
  | { readonly kind: "assignment" }
  /** Any staff-origin outbound request (a staff reply). */
  | { readonly kind: "reply" }
  /** A STATUS conversation event. */
  | { readonly kind: "status"; readonly to: "OPEN" | "PENDING" | "RESOLVED" };

export type TakeoverOutcome =
  | {
      readonly state: "HANDED_OVER";
      readonly endReason: "system_handover";
      readonly handoverReason: "staff_assigned" | "staff_replied" | "staff_status_changed";
    }
  | {
      readonly state: "COMPLETED";
      readonly endReason: "conversation_resolved";
      readonly handoverReason: null;
    };

/**
 * The session's fate, or null when no staff control event followed its start. Precedence follows J.2's numbered list:
 * an assignment, then a staff reply, then a resolution, then any other status change. So a reply AND a resolution end the
 * session handed over (staff_replied), not completed. Every outcome sets output_suppressed_at, clears awaiting and tokens
 * and carries NO terminal notice (the database CHECK forbids a notice on these end reasons); the caller does that.
 */
export function classifyTakeover(events: readonly StaffControlEvent[]): TakeoverOutcome | null {
  if (events.length === 0) return null;
  if (events.some((e) => e.kind === "assignment"))
    return { state: "HANDED_OVER", endReason: "system_handover", handoverReason: "staff_assigned" };
  if (events.some((e) => e.kind === "reply"))
    return { state: "HANDED_OVER", endReason: "system_handover", handoverReason: "staff_replied" };
  if (events.some((e) => e.kind === "status" && e.to === "RESOLVED"))
    return { state: "COMPLETED", endReason: "conversation_resolved", handoverReason: null };
  return {
    state: "HANDED_OVER",
    endReason: "system_handover",
    handoverReason: "staff_status_changed",
  };
}
