import type { Diagnostic } from "@/modules/bots";
import { AppError } from "@/shared/errors/app-error";

// Refusals of bot-management operations. Fixed messages and codes; never configuration text or student content.

export type BotControlErrorCode =
  | "STALE_REVISION"
  | "NO_DRAFT"
  | "DRAFT_INVALID"
  | "FLOW_INVALID"
  | "BOT_KEY_TAKEN"
  | "DEPLOYMENT_EXISTS"
  | "PRIORITY_TAKEN"
  | "ROUTING_CONFLICT"
  | "INVALID_TRANSITION"
  | "SAME_VERSION"
  | "CONFIRMATION_MISMATCH";

const STATUS: Record<BotControlErrorCode, number> = {
  STALE_REVISION: 409,
  NO_DRAFT: 409,
  DRAFT_INVALID: 422,
  FLOW_INVALID: 422,
  BOT_KEY_TAKEN: 409,
  DEPLOYMENT_EXISTS: 409,
  PRIORITY_TAKEN: 409,
  ROUTING_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  SAME_VERSION: 409,
  CONFIRMATION_MISMATCH: 409,
};

export class BotControlError extends AppError {
  constructor(
    code: BotControlErrorCode,
    message: string,
    /** A short code (e.g. the JSON-shape problem or the current status); never a value from the configuration. */
    readonly reason?: string,
    /** FLOW_INVALID only: the validator's path-addressed diagnostics. */
    readonly diagnostics?: readonly Diagnostic[],
  ) {
    super(code, message, STATUS[code]);
    this.name = "BotControlError";
  }
}
