// Outbound configuration, read from an explicit environment object. EVERY gate is "exactly the string true"; anything else
// (unset, "TRUE", "1", "yes") is off. No default enables sending. No token is read here: a token is looked up by
// the transport at send time, from the variable NAMED by whatsapp_accounts.credential_ref, and is never stored or logged.

export type OutboundConfig = {
  /** Staff may queue outbound requests, and the outbound worker may start. */
  readonly outboundEnabled: boolean;
  /** The transport may make a real HTTP request to Meta. Checked again at the HTTP boundary. */
  readonly liveSendEnabled: boolean;
  /**
   * Sending to a BSUID through the `recipient` field. Meta's documentation of that field is marked "coming soon" and the
   * message-API reference does not list it, so it stays OFF until a live test proves it (docs/WHATSAPP_OUTBOUND_EVIDENCE.md).
   */
  readonly bsuidRecipientEnabled: boolean;
  /** Graph API version such as v25.0. Required for a live send; deliberately has no default. */
  readonly graphApiVersion: string | null;
};

type Env = Record<string, string | undefined>;
const flag = (env: Env, name: string) => env[name] === "true";
const VERSION = /^v[0-9]{2}\.[0-9]{1,2}$/;

export function readOutboundConfig(env: Env): OutboundConfig {
  const version = env.WHATSAPP_GRAPH_API_VERSION;
  return {
    outboundEnabled: flag(env, "WHATSAPP_OUTBOUND_ENABLED"),
    liveSendEnabled: flag(env, "WHATSAPP_LIVE_SEND_ENABLED"),
    bsuidRecipientEnabled: flag(env, "WHATSAPP_BSUID_RECIPIENT_ENABLED"),
    graphApiVersion: version !== undefined && VERSION.test(version) ? version : null,
  };
}
