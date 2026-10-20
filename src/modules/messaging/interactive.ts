import { z } from "zod";
import { TEXT_BODY_MAX } from "./policy";

// Interactive reply-button and list messages (Phase 08D, ADR 0020). BOT requests only: staff send text and templates.
//
// ONE versioned shape, InteractivePayload, is the only thing written and the only thing read. enqueueAutomatedMessage stores
// it unchanged in outbound_requests.payload AND messages.content.interactive; the dispatcher parses it again with the same
// schema before sending (a stored value that no longer parses is HELD `payload_invalid`, never sent); buildPayload turns it
// into Meta's JSON. Nothing is reconstructed from memory, so a restarted worker sends exactly what was stored.
//
// Limits: Meta's reply-button and list-message reference pages (re-read 2026-10-19, Graph v26.0) state every limit in
// "characters" without defining the unit. We count UTF-16 code units (checked explicitly below), which is never fewer than
// code points or grapheme clusters, so a value we accept is within Meta's limit whatever its unit. The list body is capped at the
// flow contract's 1024 although Meta allows 4096. Meta marks a list section title REQUIRED even for a single section, so the
// stored shape always carries one. Reply ids are the bot contract's `b1.<token>.<key>` (bots/reply-id.ts; equality of the two
// patterns is pinned by a test), well inside Meta's 256 (button) and 200 (row) maxima.

export const INTERACTIVE_LIMITS = {
  bodyMax: 1024,
  footerMax: 60,
  buttonsMin: 1,
  buttonsMax: 3,
  buttonTitleMax: 20,
  buttonIdMax: 256,
  listButtonLabelMax: 20,
  sectionsMax: 10,
  sectionTitleMax: 24,
  rowsMax: 10,
  rowTitleMax: 24,
  rowDescriptionMax: 72,
  rowIdMax: 200,
} as const;

/** The bot reply-id grammar (copy of bots/reply-id.ts REPLY_ID_PATTERN; messaging does not import the bots module). */
export const REPLY_ID_PATTERN = /^b1\.[A-Za-z0-9_-]{22}\.[a-z][a-z0-9_]{0,31}$/;

const L = INTERACTIVE_LIMITS;
// Lengths are checked in UTF-16 code units explicitly: the installed zod's .max() counts code points, which is the LESS strict
// unit (an emoji outside the Basic Multilingual Plane is one code point but two units).
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => v.length <= max, { message: `at most ${max} UTF-16 code units` });
const replyId = (max: number) =>
  z
    .string()
    .regex(REPLY_ID_PATTERN)
    .refine((v) => v.length <= max);

const buttons = z.strictObject({
  v: z.literal(1),
  kind: z.literal("buttons"),
  body: text(L.bodyMax),
  footer: text(L.footerMax).optional(),
  buttons: z
    .array(z.strictObject({ id: replyId(L.buttonIdMax), title: text(L.buttonTitleMax) }))
    .min(L.buttonsMin)
    .max(L.buttonsMax),
});

const list = z.strictObject({
  v: z.literal(1),
  kind: z.literal("list"),
  body: text(L.bodyMax),
  footer: text(L.footerMax).optional(),
  buttonLabel: text(L.listButtonLabelMax),
  sections: z
    .array(
      z.strictObject({
        title: text(L.sectionTitleMax),
        rows: z
          .array(
            z.strictObject({
              id: replyId(L.rowIdMax),
              title: text(L.rowTitleMax),
              description: text(L.rowDescriptionMax).optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(L.sectionsMax),
});

export const interactivePayloadSchema = z
  .discriminatedUnion("kind", [buttons, list])
  .superRefine((p, ctx) => {
    const options =
      p.kind === "buttons" ? p.buttons : p.sections.flatMap((s) => s.rows as { id: string }[]);
    if (p.kind === "list" && options.length > L.rowsMax)
      ctx.addIssue({ code: "custom", message: "too_many_rows" });
    const ids = options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate_id" });
    if (p.kind === "buttons" && new Set(p.buttons.map((b) => b.title)).size !== p.buttons.length)
      ctx.addIssue({ code: "custom", message: "duplicate_title" });
  });

export type InteractivePayload = z.infer<typeof interactivePayloadSchema>;

/** The stored payload, or null when it is not exactly a valid InteractivePayload. */
export function parseInteractivePayload(value: unknown): InteractivePayload | null {
  const r = interactivePayloadSchema.safeParse(value);
  return r.success ? r.data : null;
}

/**
 * The message a bot step asks to send, structurally identical to the bot engine's OutboundMessage (bots/engine.ts; the
 * equivalence is pinned by a type test). Messaging does not import the bots module.
 */
export type BotOutboundMessage =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "buttons";
      readonly body: string;
      readonly footer?: string;
      readonly buttons: readonly { readonly id: string; readonly title: string }[];
    }
  | {
      readonly kind: "list";
      readonly body: string;
      readonly buttonLabel: string;
      readonly footer?: string;
      readonly rows: readonly {
        readonly id: string;
        readonly title: string;
        readonly description?: string;
      }[];
    };

export type BotSendContent =
  | { readonly type: "text"; readonly body: string }
  | { readonly type: "interactive"; readonly payload: InteractivePayload };

/**
 * Maps an engine message to what is stored. A flat engine list becomes ONE section titled with the list's button label
 * (Meta requires a section title; the label is at most 20 characters, within the 24 a title allows). Returns null when the
 * result is not valid (nothing is stored then).
 */
export function botSendContent(m: BotOutboundMessage): BotSendContent | null {
  if (m.kind === "text")
    return m.text.length >= 1 && m.text.length <= TEXT_BODY_MAX
      ? { type: "text", body: m.text }
      : null;
  const footer = m.footer === undefined ? {} : { footer: m.footer };
  const candidate =
    m.kind === "buttons"
      ? {
          v: 1,
          kind: "buttons",
          body: m.body,
          ...footer,
          buttons: m.buttons.map((b) => ({ id: b.id, title: b.title })),
        }
      : {
          v: 1,
          kind: "list",
          body: m.body,
          ...footer,
          buttonLabel: m.buttonLabel,
          sections: [
            {
              title: m.buttonLabel,
              rows: m.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description === undefined ? {} : { description: r.description }),
              })),
            },
          ],
        };
  const payload = parseInteractivePayload(candidate);
  return payload === null ? null : { type: "interactive", payload };
}

/** Meta's `interactive` object for a stored payload. Optional fields are omitted, never sent as null. */
export function providerInteractive(p: InteractivePayload): Record<string, unknown> {
  const footer = p.footer === undefined ? {} : { footer: { text: p.footer } };
  if (p.kind === "buttons")
    return {
      type: "button",
      body: { text: p.body },
      ...footer,
      action: {
        buttons: p.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
      },
    };
  return {
    type: "list",
    body: { text: p.body },
    ...footer,
    action: {
      button: p.buttonLabel,
      sections: p.sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description === undefined ? {} : { description: r.description }),
        })),
      })),
    },
  };
}
