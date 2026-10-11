import { AppError } from "@/shared/errors/app-error";

// Client-visible outbound errors. Messages are fixed text plus a fixed reason code: never a recipient, a message body,
// an identifier or a provider response.

/** The request is understood but this message may not be sent now (policy). 422. `reason` is a fixed snake_case code. */
export class OutboundRefusedError extends AppError {
  constructor(readonly reason: string) {
    super("OUTBOUND_REFUSED", `This message cannot be sent: ${reason}`, 422);
    this.name = "OutboundRefusedError";
  }
}

/** The idempotency key was already used by this requester for a DIFFERENT request. 409. */
export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for a different request",
      409,
    );
    this.name = "IdempotencyConflictError";
  }
}
