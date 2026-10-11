// PUBLIC API of the messaging module (outbound WhatsApp). Routes use ONLY these: they authenticate nothing themselves and
// perform no network I/O. Dispatching to Meta is the separate, opt-in outbound worker (scripts/whatsapp-outbound-worker.ts).
export {
  getOutboundRequest,
  submitOutboundMessage,
  type OutboundRequestView,
  type SubmitDeps,
  type SubmitResult,
} from "./submit";
export { IdempotencyConflictError, OutboundRefusedError } from "./errors";
