// The standalone bot worker (Phase 08E-7). NOT imported by the application: started only by `npm run bots:worker`
// (scripts/bots-worker.ts), and only with BOTS_RUNTIME_ENABLED and WHATSAPP_OUTBOUND_ENABLED both exactly "true".
// Importing this module starts nothing.
export { EXIT_FATAL, EXIT_REFUSED, EXIT_STOPPED, runBotWorker, type RunOptions } from "./run";
export { readBotWorkerConfig, type BotWorkerConfig, type BotWorkerConfigResult } from "./config";
