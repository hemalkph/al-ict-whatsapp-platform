// PUBLIC API of the leads module (Phase 07B). Pages and routes use ONLY these: authorization is checked inside each function
// (never in the UI), every query is organization-scoped, and nothing here sends to Meta, reads a provider URL or touches the
// inbound pipeline. Leads are created manually by staff here; automatic creation from ad referrals is the reconciler's job (07C), which is deliberately NOT exported from here: it is an opt-in command (scripts/leads-reconcile.ts), so nothing that imports this module can start it.
export { createManualLead } from "./create";
export { changeLeadStatus } from "./workflow";
export { listLeads } from "./list";
export { getLeadDetail } from "./detail";
export { listLeadEvents } from "./history";
export { getContactLeads } from "./for-contact";
export { LeadConflictError, type LeadConflictCode } from "./errors";
export type { LeadsDeps } from "./items";
export { ALL_LEAD_STATUSES, isOpenStatus, isReserved, isStaffSettable } from "./rules";
export {
  NO_REFERRAL_LABEL,
  type ContactLabel,
  type ContactLeads,
  type ConversationRef,
  type CreateLeadResult,
  type LeadDetail,
  type LeadEventPage,
  type LeadEventView,
  type LeadItem,
  type LeadPage,
  type LeadStatus,
  type OtherEvidenceView,
  type SourceSummary,
  type StatusChangeResult,
  type TouchView,
} from "./types";
