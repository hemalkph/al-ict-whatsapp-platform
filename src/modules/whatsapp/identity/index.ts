// Internal contact identity resolution. NOT part of the module's public API (../index.ts). Used by the inbound message
// handler (a later checkpoint) inside the worker's transaction.
export { identityLockKeys, resolveInboundContact } from "./resolve";
export type { ContactResolution, IdentityConflict, TrustedWebhookEvent } from "./resolve";
export { readInboundIdentity, sanitizeDisplayText } from "./profile";
export type { InboundIdentity } from "./profile";
