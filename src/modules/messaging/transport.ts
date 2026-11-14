import type { InteractivePayload } from "./interactive";

// The boundary between the dispatcher and Meta. The dispatcher knows only this interface; tests supply a fake, production
// supplies MetaTransport. A transport never throws for an expected outcome: it classifies what happened into exactly one
// SendResult, and the dispatcher treats a thrown error as UNKNOWN (the safe reading).

export type SendRecipient = { readonly kind: "PHONE" | "BSUID"; readonly id: string };

export type SendMessage =
  | { readonly type: "text"; readonly body: string; readonly replyToWamid: string | null }
  /** Reply buttons or a list (Phase 08D, BOT requests only): the stored, re-validated InteractivePayload. */
  | { readonly type: "interactive"; readonly payload: InteractivePayload }
  | {
      readonly type: "template";
      readonly name: string;
      readonly languageCode: string;
      readonly bodyParameters: readonly string[];
    };

export type SendRequest = {
  /** The account's trusted phone_number_id (from whatsapp_accounts, never from browser input). */
  readonly phoneNumberId: string;
  /** NAME of the server-side secret that holds the access token (whatsapp_accounts.credential_ref). Never the token. */
  readonly credentialRef: string | null;
  readonly recipient: SendRecipient;
  readonly message: SendMessage;
};

/**
 * What happened to ONE send attempt. The distinction between `not_sent` and `unknown` is the heart of duplicate-send
 * safety: only a result that PROVES the request never reached Meta may be retried.
 */
export type SendResult =
  /** Meta returned a message id. Acceptance only; delivery and read arrive later as STATUS webhooks. */
  | {
      readonly kind: "accepted";
      readonly wamid: string;
      readonly providerStatus: string | null;
      readonly httpStatus: number;
    }
  /** Meta conclusively refused the request. Final. */
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly httpStatus: number | null;
      readonly providerErrorCode: string | null;
    }
  /** Meta refused it because of a rate limit; nothing was created. May be retried later, honouring the hint. */
  | {
      readonly kind: "throttled";
      readonly retryAfterMs: number | null;
      readonly httpStatus: number | null;
      readonly providerErrorCode: string | null;
    }
  /** PROVEN not to have left this process (a gate, a missing credential, a connection that could not be made). May be retried. */
  | { readonly kind: "not_sent"; readonly reason: string }
  /** May have reached Meta. NEVER retried automatically. */
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly httpStatus: number | null;
      /** The numeric Meta error code when the answer was a well-formed error object (kept for operators; never the text). */
      readonly providerErrorCode?: string | null;
    };

/**
 * Lets the transport tell the dispatcher the instant it begins an HTTP attempt. After `httpStarted()` NOTHING the transport
 * returns can be read as "not sent": the dispatcher turns a not_sent result that follows it into UNKNOWN_OUTCOME, so a
 * fake, a bug or a future transport cannot claim to have proof about an HTTP operation it had already started.
 */
export interface SendHooks {
  httpStarted(): void;
}

export interface OutboundTransport {
  send(request: SendRequest, signal: AbortSignal, hooks?: SendHooks): Promise<SendResult>;
}

/** An HTTP attempt that began and then failed. It never says how far the request got; it is always UNKNOWN_OUTCOME. */
export class HttpAttemptError extends Error {
  constructor(readonly kind: "timeout" | "aborted" | "network" | "response_incomplete") {
    super(`http_attempt_${kind}`);
  }
}
