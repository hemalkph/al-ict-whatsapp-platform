// PUBLIC API of the bot runtime module (Phase 08E). At checkpoint 08E-1 it contains constants and policy, gates,
// start eligibility, the message-to-input mapping, the session row mapping, the takeover classifier, retry arithmetic and the
// fixed-field log events. Decision helpers are pure; emitBotRuntimeLog intentionally logs and reads the clock via the shared
// logger. It reads no database, calls no transport, creates no session or request and has NO production
// caller; every automation gate stays off. The step transaction, the queue primitives and the worker are later checkpoints.
export * from "./policy";
export * from "./config";
export * from "./eligibility";
export * from "./input";
export * from "./session-row";
export * from "./takeover";
export * from "./backoff";
export * from "./log";
